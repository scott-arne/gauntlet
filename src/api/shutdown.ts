/**
 * Graceful daemon shutdown for `gauntlet serve`. PRI-1477A.
 *
 * On SIGTERM/SIGINT/SIGHUP the daemon should:
 *   1. Mark itself as draining so new POSTs return 503
 *   2. Close existing WS connections with code 1001 ("going away")
 *   3. Wait up to `GAUNTLET_SHUTDOWN_GRACE_MS` for in-flight runs to complete
 *   4. Stop the HTTP server and `process.exit(0)`
 *
 * In-flight runs that exceed the grace window are abandoned mid-loop today
 * (orphan partial dirs remain). PRI-1507 will close that gap once
 * PRI-1481's unified orchestrator lands and we can thread cancellation
 * through `runAgent`.
 */

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

interface RegistryLike {
  list(): Array<unknown>;
}

export interface DrainShutdownOptions {
  signal: ShutdownSignal;
  state: ShutdownState;
  broadcaster: BroadcasterLike;
  setBroadcaster: BroadcasterLike;
  registry: RegistryLike;
  /** Maximum time to wait for in-flight runs to complete naturally. */
  graceMs: number;
  /** Polling interval for `registry.list().length === 0`. */
  pollMs: number;
  /** Where to write progress messages — process.stderr.write in production,
   * a buffer in tests. */
  log: (msg: string) => void;
}

export interface DrainResult {
  /** True when the registry emptied within graceMs. False when graceMs
   * expired with runs still listed. */
  drainedCleanly: boolean;
  /** Count of runs still in the registry at return time. */
  remaining: number;
  /** Wall-clock duration in milliseconds. */
  elapsedMs: number;
}

export async function drainShutdown(opts: DrainShutdownOptions): Promise<DrainResult> {
  const { signal, state, broadcaster, setBroadcaster, registry, graceMs, pollMs, log } = opts;

  state.mark(signal);
  log(`shutdown signaled (${signal}); draining for up to ${graceMs}ms`);

  // Close per-run WS subscribers and run-set subscribers. Errors from any
  // single client must not block the rest — broadcaster implementations
  // already swallow individual client failures.
  broadcaster.closeAll(1001, "shutting down");
  setBroadcaster.closeAll(1001, "shutting down");

  const startedAt = Date.now();
  const deadline = startedAt + graceMs;

  while (true) {
    const remaining = registry.list().length;
    if (remaining === 0) {
      const elapsedMs = Date.now() - startedAt;
      log(`drain complete in ${elapsedMs}ms`);
      return { drainedCleanly: true, remaining: 0, elapsedMs };
    }
    if (Date.now() >= deadline) {
      const elapsedMs = Date.now() - startedAt;
      log(`drain timeout after ${elapsedMs}ms; ${remaining} run(s) still in flight`);
      return { drainedCleanly: false, remaining, elapsedMs };
    }
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
