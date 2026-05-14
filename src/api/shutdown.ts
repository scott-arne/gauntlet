/**
 * Graceful daemon shutdown for `gauntlet serve`. PRI-1477A + PRI-1507.
 *
 * On SIGTERM/SIGINT/SIGHUP the daemon should:
 *   1. Mark itself as draining so new POSTs return 503
 *   2. Close existing WS connections with code 1001 ("going away")
 *   3. Wait up to `GAUNTLET_SHUTDOWN_GRACE_MS` for in-flight runs to complete
 *   4. If runs are still in flight after grace:
 *      a. cancelTokens.cancelAll() — gate run-set loops from starting more attempts
 *      b. registry.abortAll() — fire per-run AbortControllers so agent loops exit
 *      c. wait up to postAbortMs (default 1000) for runs to write result.json
 *      d. writeShutdownStubs for any run still missing result.json
 *   5. Stop the HTTP server and `process.exit(0)`
 *
 * See spec/plan: docs/superpowers/specs/2026-05-13-shutdown-drain-cancellation-spec.md
 */

import { writeShutdownStubs } from "./shutdown-stub-writer";

export type ShutdownSignal = "SIGTERM" | "SIGINT" | "SIGHUP";

export class ShutdownState {
  private draining = false;
  private _signal: ShutdownSignal | null = null;
  private _signaledAt: number | null = null;

  isDraining(): boolean {
    return this.draining;
  }

  /** First signal wins; subsequent calls are no-ops. */
  mark(signal: ShutdownSignal): void {
    if (this.draining) return;
    this.draining = true;
    this._signal = signal;
    this._signaledAt = Date.now();
  }

  get signal(): ShutdownSignal | null {
    return this._signal;
  }

  get signaledAt(): number | null {
    return this._signaledAt;
  }
}

interface BroadcasterLike {
  closeAll(code: number, reason: string): void;
}

/** Minimal interface so tests can substitute a stub. The real
 * ActiveRunRegistry satisfies this. */
interface RegistryLike {
  list(): Array<{ id: string; cardId: string; startedAt: number }>;
  abortAll(reason: string): number;
}

interface CancelTokensLike {
  cancelAll(): number;
}

export interface DrainShutdownOptions {
  signal: ShutdownSignal;
  state: ShutdownState;
  broadcaster: BroadcasterLike;
  setBroadcaster: BroadcasterLike;
  registry: RegistryLike;
  /** Run-set cancel tokens. Optional so existing single-pass tests can
   * omit it. Production always wires one in. */
  cancelTokens?: CancelTokensLike;
  /** Directory containing per-run dirs. Needed for the stub writer fallback. */
  resultsRoot: string;
  /** Maximum time to wait for in-flight runs to complete naturally. */
  graceMs: number;
  /** Patience window after firing abortAll, for agent loops to observe
   * the abort and write their result.json via the orchestrator's normal
   * success path. Default 1000ms when omitted. */
  postAbortMs?: number;
  /** Polling interval for `registry.list().length === 0`. */
  pollMs: number;
  /** Where to write progress messages — process.stderr.write in production,
   * a buffer in tests. */
  log: (msg: string) => void;
}

export interface DrainResult {
  /** True when the registry emptied within graceMs (no abort needed). */
  drainedCleanly: boolean;
  /** Count of runs still in the registry at return time. */
  remaining: number;
  /** Count of AbortControllers fired by abortAll (0 on the clean path). */
  aborted: number;
  /** Count of stub result.json files written (0 if either drainedCleanly
   * or every aborted run cleaned up before the patience window closed). */
  stubbed: number;
  /** Wall-clock duration in milliseconds. */
  elapsedMs: number;
}

export async function drainShutdown(opts: DrainShutdownOptions): Promise<DrainResult> {
  const { signal, state, broadcaster, setBroadcaster, registry, cancelTokens,
          resultsRoot, graceMs, postAbortMs, pollMs, log } = opts;

  state.mark(signal);
  log(`shutdown signaled (${signal}); draining for up to ${graceMs}ms`);

  // Close per-run WS subscribers and run-set subscribers. Errors from any
  // single client must not block the rest — broadcaster implementations
  // already swallow individual client failures.
  broadcaster.closeAll(1001, "shutting down");
  setBroadcaster.closeAll(1001, "shutting down");

  const startedAt = Date.now();

  // Grace window: poll for natural drain.
  const afterGrace = await pollUntilEmpty(registry, startedAt + graceMs, pollMs);
  if (afterGrace === 0) {
    const elapsedMs = Date.now() - startedAt;
    log(`drain complete in ${elapsedMs}ms`);
    return { drainedCleanly: true, remaining: 0, aborted: 0, stubbed: 0, elapsedMs };
  }

  // Grace expired with runs in flight. Step 1: cancel run-set tokens so
  // multi-pass loops don't start a fresh attempt during the patience
  // window. Step 2: fire AbortControllers so in-flight agent loops exit.
  log(`drain timeout after ${Date.now() - startedAt}ms; ${afterGrace} run(s) still in flight`);

  const cancelled = cancelTokens?.cancelAll() ?? 0;
  if (cancelled > 0) {
    log(`cancelled ${cancelled} run-set token(s) to gate further attempts`);
  }

  const aborted = registry.abortAll("shutdown");
  log(`aborted ${aborted} in-flight run(s)`);

  // Patience window: agent loops should observe the abort at their next
  // check, then return a synthetic errored VetResult; the orchestrator's
  // success path writes result.json and the wrapper's afterClose hook
  // unregisters. Most cooperative agents drain within a few hundred ms.
  const patienceMs = postAbortMs ?? 1000;
  const afterPatience = await pollUntilEmpty(registry, Date.now() + patienceMs, pollMs);

  if (afterPatience === 0) {
    const elapsedMs = Date.now() - startedAt;
    log(`all runs cleaned up after abort (${elapsedMs}ms total)`);
    return { drainedCleanly: false, remaining: 0, aborted, stubbed: 0, elapsedMs };
  }

  // Patience window also expired. Last resort: write a stub result.json
  // for any run that didn't get one from its agent loop. The existsSync
  // check in writeShutdownStubs preserves any result the agent did
  // manage to flush.
  const stillListed = registry.list();
  const stubbed = writeShutdownStubs(
    stillListed.map((r) => ({ runId: r.id, cardId: r.cardId, startedAt: r.startedAt })),
    resultsRoot,
  );
  log(
    `wrote ${stubbed} stub result.json file(s) for run(s) that did not exit cleanly ` +
    `(${stillListed.length - stubbed} already had a result.json)`,
  );

  const elapsedMs = Date.now() - startedAt;
  return {
    drainedCleanly: false,
    remaining: stillListed.length,
    aborted,
    stubbed,
    elapsedMs,
  };
}

async function pollUntilEmpty(
  registry: RegistryLike,
  deadline: number,
  pollMs: number,
): Promise<number> {
  while (true) {
    const remaining = registry.list().length;
    if (remaining === 0) return 0;
    if (Date.now() >= deadline) return remaining;
    await sleep(pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Install signal handlers that orchestrate shutdown via `drainShutdown`.
 * Returns a detach function for tests / clean teardown. The handler is
 * registered once per signal — subsequent signals after the first are
 * no-ops because `state.mark()` is idempotent.
 *
 * After drain returns, the caller is responsible for stopping the HTTP
 * server and exiting the process. We keep that out of this helper so the
 * orchestration is testable without process.exit side effects.
 */
export function installShutdownHandlers(
  signals: ShutdownSignal[],
  onSignal: (signal: ShutdownSignal) => void,
): () => void {
  const handlers: Array<[ShutdownSignal, () => void]> = signals.map((s) => [
    s,
    () => onSignal(s),
  ]);
  for (const [s, h] of handlers) process.on(s, h);
  return () => {
    for (const [s, h] of handlers) process.removeListener(s, h);
  };
}
