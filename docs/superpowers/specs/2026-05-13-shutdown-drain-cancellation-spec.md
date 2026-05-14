# Shutdown drain — in-flight run cancellation and `errored` result persistence

**Status:** revised after Bob review (Mordin@261b95c8, 2026-05-13)
**Author:** Granny Weatherwax@1f6f7ef0 (Opus 4.7)
**Linear:** PRI-1507
**Related:** `src/runs/orchestrator.ts`, `src/agent/agent.ts`, `src/api/shutdown.ts`, `src/api/active-runs.ts`, `src/api/routes/run.ts`, `src/evidence/logger.ts`, `src/types.ts`, `docs/format.md`, `docs/superpowers/specs/2026-05-04-shared-run-orchestrator-design.md`, `docs/superpowers/specs/2026-05-11-time-budget-and-stuck-detection-spec.md`

---

## Problem

`gauntlet serve` now handles `SIGTERM`/`SIGINT`/`SIGHUP` (PRI-1477A) and waits up to `GAUNTLET_SHUTDOWN_GRACE_MS` (default 10s) for in-flight runs to finish naturally. When the grace window expires with runs still in flight, the daemon stops the HTTP server and exits — leaving each unfinished run as an orphan partial directory under `<projectRoot>/.gauntlet/results/<runId>/`:

```
inputs/
screenshots/
run.jsonl       (truncated mid-loop, no run_end event)
                (no result.json)
```

`/api/results/:runId` reads `result.json`, so it returns 404 for orphans. From a consumer's perspective these runs simply vanished; there's no way to tell "interrupted by shutdown" from "never existed".

PRI-1481's open question — "cancellation mid-attempt is out of scope" — left no primitive to interrupt a running `runAgent`, so persisting in-flight runs as `errored` was racy or impossible. PRI-1481 has now landed (`executeRunCore` exists; `src/runs/orchestrator.ts:148`), and PRI-1477A's `drainShutdown` already returns `{drainedCleanly, remaining, elapsedMs}` from `src/api/shutdown.ts:77`. The hooks and the seam are both present; we can wire cancellation through them.

## Decisions

These were settled with Matt before drafting (so the spec doesn't relitigate them):

1. **Schema bump to v5.** Add `"errored"` to `VetStatus` and an optional `error: { type, message }` field to `VetResult`. Faithful to the ticket framing — the whole point of draining is so consumers can distinguish an interrupted run from a self-terminated one. The categorical signal is worth the call-site sweep.
2. **Schema doc lives in `docs/format.md`.** The ticket's `docs/format-runjsonl.md` reference is dead — that file doesn't exist; the canonical schema and `run.jsonl` event list both live in `docs/format.md`.

## Goal

When the shutdown grace window expires with runs still in flight, every in-flight run ends up with a complete on-disk record:

- `result.json` with `status: "errored"` and `error: { type: "shutdown_interrupted", message: ... }`
- `run.jsonl` containing a `shutdown_signaled` named event prior to truncation
- `/api/results/:runId` returns 200 with the errored manifest, not 404

## Design

### 1. Cancellation primitive: `AbortSignal` through `executeRunCore`

Add a single optional field to the orchestrator's options:

```ts
// src/runs/orchestrator.ts
export interface ExecuteRunCoreOptions {
  // ... existing fields
  /**
   * Optional cancellation signal. When aborted, the agent loop exits at
   * its next abort check (between turns, or between adjacent tool calls
   * within a turn) by **returning** a synthetic `errored` VetResult; the
   * orchestrator then runs its normal success-path cleanup (write result
   * files, close adapter, detach logger). Production wires this from a
   * per-run AbortController held in the active-run registry.
   */
  abortSignal?: AbortSignal;
}
```

**Invariant — agent must not throw on abort.** The agent loop **returns** a synthetic errored `VetResult`; it does not throw an `AbortError` or similar. This is load-bearing: `executeRunCore`'s `catch` block (orchestrator.ts:218) calls `logger.logRunError` and rethrows but **does not** call `writeResultFiles`. If the agent threw on abort, every aborted run would skip result-file writing and fall through to the §3 stub fallback — defeating the whole "real errored result with accumulated usage data" path. The catch block remains for genuine adapter/agent failures only.

Forward `abortSignal` into `runAgent`'s options (single new field on `AgentOptions`). The agent loop checks it at **two** points, both at boundaries where externally-visible state is fully consistent:

```ts
// src/agent/agent.ts (sketch)
while (Date.now() < deadline) {
  if (isAborted()) return abortedResult();    // (a) between turns
  // ... LLM call, response handling ...
  if (response.toolCalls.length > 0) {
    pushAssistantTurn(messages, response.rawAssistantMessage);
    for (const tc of response.toolCalls) {
      if (isAborted()) return abortedResult(); // (b) between adjacent tool calls
      // ... existing tool-call body
    }
  }
}

const isAborted = () => options.abortSignal?.aborted === true;

const abortedResult = () => {
  logger.logShutdownSignaled({
    turn: turns,
    reason: String(options.abortSignal?.reason ?? "unknown"),
  });
  return buildResult({
    status: "errored",
    summary: "Run interrupted by shutdown signal",
    reasoning: `Daemon shutdown signal received at turn ${turns}; agent loop terminated before completion.`,
    error: { type: "shutdown_interrupted", message: "interrupted by shutdown signal" },
  });
};
```

`buildResult` is extended to accept an optional `error` field that flows into the returned `VetResult`. The two check points were chosen because:

- **Between turns** is the cheapest natural exit — full message-list consistency, no in-flight LLM/tool work.
- **Between adjacent tool calls within a turn** is also free (one branch per iteration; partial `results` array can be safely discarded — `messages` hasn't been mutated for the truncated portion of the turn). Web adapter turns commonly emit 5+ tool calls back-to-back (screenshot/click/screenshot/extract/screenshot); checking here drops worst-case bail time from ~45s to ~30s with zero adapter-contract changes. Credit: Mordin@261b95c8.

Mid-LLM-call and mid-tool-call abort remain out of scope (would orphan a billable LLM request and leave the adapter in an indeterminate mid-action state respectively).

Worst case after both checks: one full LLM round-trip + one full tool call = ~30s. Acceptable for shutdown drain.

### 2. AbortController storage: extend the active-run registry

`ActiveRunRegistry` in `src/api/active-runs.ts:32` keys runs by `runId`. Add an optional `abortController` field on `RunSnapshot` (not on the public `ActiveRunInfo` payload — the controller is internal infrastructure, not something consumers should see):

```ts
// src/api/active-runs.ts
export interface RunSnapshot {
  info: ActiveRunInfo;
  lastFrame: ...;
  progressLog: string[];
  abortController?: AbortController;  // NEW
}

// New method:
attachAbortController(runId: string, ac: AbortController): void { ... }
abortAll(reason: string): number { ... }  // returns count aborted
```

`abortAll` iterates the map, calls `abort(reason)` on each non-null controller, and returns how many it fired. It tolerates double-abort (idempotent on `AbortController`).

### 3. Shutdown wiring: drain → abort → patience → stub

Extend `drainShutdown` in `src/api/shutdown.ts` with a post-grace cancellation step. Pseudocode:

```
drainShutdown(...):
  state.mark(signal)
  broadcaster.closeAll(1001, "shutting down")
  setBroadcaster.closeAll(1001, "shutting down")

  poll registry.list().length === 0 until empty or graceMs deadline

  if drained cleanly:
    return { drainedCleanly: true, remaining: 0, elapsedMs }

  // NEW: post-grace cancellation
  log "drain timeout after Xms; aborting N in-flight run(s)"
  const aborted = registry.abortAll("shutdown")

  // Brief patience window so agent loops can observe abort + write
  // result files via the orchestrator's normal cleanup path
  poll registry.list().length === 0 until empty or postAbortMs deadline
  // postAbortMs default: 1000

  if registry.list().length === 0:
    log "all runs cleaned up after abort"
    return { drainedCleanly: false, aborted, remaining: 0, elapsedMs }

  // NEW: last-resort stub writer for any run whose result.json is still
  // missing. Race-safe: only writes if file does not exist on disk.
  const stubbed = writeShutdownStubs(registry.list(), resultsRoot)
  log "wrote N stub result.json files for runs that did not exit cleanly"
  return { drainedCleanly: false, aborted, remaining, stubbed, elapsedMs }
```

`writeShutdownStubs` walks each remaining run's directory and writes a minimal `result.json` if and only if the file doesn't already exist. The race window is narrow but real: between `writeResultFiles` (orchestrator.ts:210) and the run's `unregister` in the `finally` block of `executeHttpRun`, the patience window could expire. **Ordering invariant:** `writeResultFiles` happens before `unregister` in both solo and multi-pass paths today, by accident of code order. The plan must make this a documented constraint with a test, so a future refactor doesn't reorder them and break the existsSync defense.

The stub shape:

```json
{
  "schemaVersion": 5,
  "runId": "<id>",
  "scenario": "<cardId>",
  "status": "errored",
  "summary": "Run interrupted by shutdown signal (no record from agent)",
  "reasoning": "Daemon shutdown grace window expired with this run still in flight, and the agent loop did not write a result before the post-abort patience window also expired.",
  "observations": [],
  "evidence": { "screenshots": [], "log": "run.jsonl" },
  "duration_ms": <Date.now() - registry.startedAt, or -1 if absent>,
  "error": { "type": "shutdown_interrupted", "message": "interrupted by shutdown signal; no agent record" }
}
```

`duration_ms` is computed from the registry's `startedAt` rather than hardcoded `0`, so consumers grouping runs by zero-duration don't mis-classify the rare adapter-start-failure case. `-1` is a documented sentinel for "registry entry missing startedAt" (shouldn't happen in production but cheap guard).

The two paths produce intentionally-different outputs. A run that observed the abort writes a "real" errored result with accumulated turn count, usage, partial observations. The stub is the floor-of-quality fallback for runs whose agent loop didn't even reach the next abort check before the patience window expired. Consumers that want to distinguish them check whether `usage` is present.

### 4. Wire it up at the API layer

In `src/api/routes/run.ts`:

- **Solo path:** right after `registry.register(...)`, construct `const ac = new AbortController(); registry.attachAbortController(runId, ac);` and pass `ac.signal` into `executeHttpRun → executeRunCore`.
- **Multi-pass path:** the existing flow has `runRunSet` started before `registry.register` runs (see implementation plan Step 5 for the ordering details). Use the existing `RunSetConfig.onAllRunsKnown` hook to register all runs *and* attach a fresh `AbortController` per run synchronously before `runLoop` starts. The executor closure looks up its run's controller by `runId` from a route-local map and forwards `ac.signal` into `executeHttpRun`.

`executeHttpRun` grows an `abortSignal?: AbortSignal` field, forwarded to `executeRunCore`. No CLI changes — `runOne` doesn't go through the daemon shutdown path; `abortSignal` is opt-in on `ExecuteRunCoreOptions`.

`drainShutdown` needs:
- the registry handle (already passed via `DrainShutdownOptions`)
- the `resultsRoot` (new field)
- the `cancelTokens` registry (new optional field) — to gate the run-set loop from starting more attempts during the patience window. Without this, a multi-pass set whose attempt 1 was just aborted would race attempt 2's startup against the stub-writer; with `cancelTokens.cancelAll()` called *before* `registry.abortAll()`, the run-set loop sees the cancel flag at its next between-attempt check and exits.

The serve case in `src/index.ts` resolves `resultsRoot` from `gauntletPath(config.projectRoot, "results")` and threads `cancelTokens` from the existing local declaration.

### 5. Schema bump (v4 → v5)

`src/types.ts`:

```ts
// v5: VetStatus gains "errored"; VetResult gains optional `error` field
//     ({type, message}) for runs that did not complete normally.
//     Today the only emitter is shutdown drain (PRI-1507).
export const RESULT_SCHEMA_VERSION = 5;

export type VetStatus = "pass" | "fail" | "investigate" | "errored";

export interface VetResult {
  // ... existing fields
  /** Set when `status: "errored"`. Categorizes the cause so consumers
   * can distinguish shutdown interruption from other future error
   * surfaces. `type` is open-typed (string) so additive new categories
   * don't require a schema bump or TypeScript type widening — consumers
   * MUST tolerate unknown `type` values. Today the only emitted type is
   * `"shutdown_interrupted"`. */
  error?: { type: string; message: string };
}
```

`error.type` is open-typed (`string`) deliberately. A literal-union approach (`"shutdown_interrupted" | "..."`) would require a TypeScript type-widening edit at the very first new category — defeating the "additive evolution without a schema bump" claim. The cost: consumers can't exhaustively switch on `type` at compile time. That's the intended cost — error surfaces grow over time and consumer rendering code should default to a generic "errored" treatment with `type` as a refinement.

### 6. Call-site sweep for `"errored"`

**Critical: `errored` already exists as a sibling status literal in run-set rollup code.** `RunEntry.status` in `src/evidence/run-set-writer.ts:11` is `"queued" | "running" | "cancelled" | VetStatus | "errored"`, and `recordRunEnd` is called with `"errored"` from the run-set executor's catch block at `src/runs/run-set.ts:121` to mean "executor threw an exception running this attempt".

After the v5 bump, `recordRunEnd(runId, ret.result.status)` at `run-set.ts:119` will *also* pass `"errored"` for an aborted-but-cleanly-returned run. Both paths land in `byStatus.errored`, which is the correct same-bucket semantics — but `summarizeCard` at `run-set-writer.ts:116-119` currently `continue`s without calling `lookup` for any errored entry. After v5, that silently drops the partial usage data (turns counted, tokens accumulated) the aborted agent did capture in its real `result.json`.

**Plan-side fix (in-scope):** extend the `errored` arm in `summarizeCard` to call `lookup(r.runId)` and include `usage.turns` / `duration_ms` if present. Keep the bucket as `byStatus.errored++` either way. The catch-path errored entries still land in the bucket but lookup returns null (no result.json), preserving today's behavior. The semantics this pins down:

- `byStatus.errored` = "this attempt did not produce a `pass`/`fail`/`investigate` verdict, regardless of whether the agent loop wrote a partial record"
- `medianTurns` / `medianDurationMs` = "across all attempts that captured measurable work, including aborted ones that recorded usage"

That matches the spec's overall philosophy: the categorical signal (`errored`) is preserved while quality math benefits from any usable data the run did capture.

The full call-site sweep — enumerated in the plan, not the spec — covers everywhere that switches on `VetStatus`:

- `src/runs/aggregate.ts` — `deriveBucket` already has an `errored` arm; verify it still makes sense after v5
- `src/evidence/run-set-writer.ts` — `summarizeCard` lookup behavior (above)
- `src/cli/stream/batch-table.ts` — render glyph + color for an errored row
- `src/cli/stream/*` — pretty-printer status badges
- `src/api/routes/run.ts` — terminal broadcast shape
- UI: `ui/src/**` — result-card status badge, batch-table glyph, filter pills
- Tests with hardcoded status enums or fixtures of `byStatus`

Spec-level intent: `"errored"` reads as a fourth peer to `pass`/`fail`/`investigate`, with red-or-grey treatment (UI choice) and "ERR" or "interrupted" copy.

### 7. New `EvidenceLogger` named event

```ts
// src/evidence/logger.ts
logShutdownSignaled(fields: { turn: number; reason: string }): void {
  this.writeEvent("shutdown_signaled", { ...fields });
}
```

Fires from the agent loop's between-turn abort check (§1). `reason` is the `AbortSignal.reason` cast to string (e.g. `"shutdown"`). Sits in the `run.jsonl` event chain like every other named event — same `eventId`/`parentEventId` linkage.

### 8. `docs/format.md` updates

- Add `shutdown_signaled` to the `run.jsonl` events list
- Add `errored` to the `status` enum doc and describe the `error` field shape
- v5 changelog entry

## Sequence — interrupted run with grace window expired

```
T+0ms     SIGTERM received → state.mark, broadcasters.closeAll
T+0ms     drain loop begins (poll registry.list every 100ms)
T+10s     graceMs deadline; registry still lists 2 runs
T+10s     cancelTokens.cancelAll("shutdown") — gates run-set loops from starting more attempts
T+10s     abortAll("shutdown") → 2 controllers fired
T+10s+ε   each agent loop, at next abort check (between turns or between adjacent tool calls):
          - logShutdownSignaled
          - return synthetic errored VetResult
          - orchestrator's success path writes result.json, closes adapter, detaches logger
          - wrapper's afterClose hook unregisters from registry
T+~11s    second poll loop sees registry empty (or hits postAbortMs)
T+~11s    if any runs still listed, writeShutdownStubs for each missing result.json
T+~11s    drainShutdown returns
T+~11s    server.stop() + process.exit(0)
```

## Acceptance criteria

1. **(a) Abort-observed path:** a run still in flight when `GAUNTLET_SHUTDOWN_GRACE_MS` expires, whose agent loop reaches its next abort check before the patience window closes, ends up with a `result.json` whose `status === "errored"`, `error.type === "shutdown_interrupted"`, AND populated `usage` (turns/tokens accumulated up to abort).
2. **(b) Stub fallback path:** a run still in flight when both the grace window and the post-abort patience window expire ends up with a stub `result.json` whose `status === "errored"`, `error.type === "shutdown_interrupted"`, no `usage` field, and `duration_ms` derived from the registry's `startedAt`.
3. For path (a) only: `run.jsonl` contains a `shutdown_signaled` event prior to the file's last byte. (Path (b) by definition has no agent-side event because the loop never reached the abort check.)
4. `GET /api/results/:runId` returns 200 with the errored manifest for both paths (no more 404s).
5. A run that completes successfully *during* the post-abort patience window finishes normally — its `result.json` reflects whatever verdict the agent reached, not an `errored` stub. (`existsSync` check in the stub writer covers this; the `writeResultFiles`-before-`unregister` ordering invariant must be enforced by a test that fails if those two are reordered.)
6. `RESULT_SCHEMA_VERSION === 5`, `VetStatus` includes `"errored"`, `docs/format.md` documents the new status, the `error` field, the `shutdown_signaled` event, and a v5 changelog entry.
7. **Run-set rollup:** `summarizeCard` calls `lookup` for `errored` entries and includes their `usage.turns` / `duration_ms` in medians when present. Catch-path errored (no result.json) preserves today's behavior of skipping medians.
8. Every `VetStatus` switch in `src/` + `ui/` handles `"errored"` (no fallthrough to a default UI badge that says "investigate" or pretends the run doesn't exist).
9. After a forced shutdown, `registry.list()` returns empty before `server.stop()` is invoked. (Guards against a future refactor that turns shutdown into a soft-restart with a leaked registry.)
10. Full `bun test` green.

## Tests

New:

- `test/api/shutdown-cancel.test.ts` — covers the four shutdown paths:
  - clean drain (no abort needed)
  - drain timeout → abort → all runs exit before patience window (no stubs, populated `usage`)
  - drain timeout → abort → some runs miss patience window → stubs written (no `usage`)
  - shutdown signal during a 0-run state (registry empty, nothing to abort)
- `test/agent/abort-signal.test.ts` — agent loop respects abortSignal at BOTH check points (between turns AND between adjacent tool calls within a turn); verifies the synthetic errored VetResult shape and the `shutdown_signaled` event in the captured logger transcript
- `test/runs/orchestrator-abort.test.ts` — orchestrator's success-path writes result.json + closes adapter when the agent returns an errored result via abort. Negative test: stub a `runAgent` that *throws* `AbortError` — assert this falls through to the catch path and demonstrates why the agent must return rather than throw (the test exists as a tripwire for accidental refactor toward throw-based abort).
- `test/runs/orchestrator-ordering.test.ts` — assert `writeResultFiles` happens before `unregister` in the wrapper. Use a stubbed registry that records a timestamp on `unregister` and a stubbed `writeResultFiles` that records a timestamp on entry; failing this test signals the existsSync defense in §3 has lost its precondition.
- `test/api/active-runs.test.ts` — extend with `attachAbortController` / `abortAll` cases including double-abort idempotency
- `test/runs/run-set-aggregate.test.ts` — extend (or new) — assert `summarizeCard` calls lookup for `errored` entries with a populated result and includes `usage.turns` / `duration_ms` in medians; catch-path errored (lookup returns null) preserves today's behavior

Update:

- `test/api/run.test.ts` — assert `AbortController` is attached to registry on register
- `test/runs/orchestrator.test.ts` — extend the existing orchestrator suite with the abort-signal-honoring case
- Any tests that assert `VetStatus` shape — add the new variant to fixtures

Regression commands:

```
bun test test/api/shutdown-cancel.test.ts
bun test test/agent/abort-signal.test.ts
bun test test/runs/orchestrator-abort.test.ts
bun test test/api/active-runs.test.ts
bun test
```

## Out of scope

- **CLI cancellation surface.** `gauntlet run` and `gauntlet batch` already have between-card SIGINT handling via `cancelToken`. Mid-card SIGINT could reuse the same `AbortSignal` plumbing, but the user-visible benefit is small (CLI runs aren't long-lived daemons accumulating orphan dirs) and adds wiring for no acceptance criterion. Defer.
- **Mid-`adapter.executeTool` cancellation.** Aborting *during* a single tool call (not between tool calls — that's in scope per §1) would mean adapter-specific cleanup contracts (web: page-level cancel? tab close? TUI: pty signal?). The 30s tool timeout already bounds worst case for a stuck individual tool call.
- **Mid-LLM-call cancellation.** Both Anthropic and OpenAI SDKs support request-level abort, but threading it through `LLMClient.chat` is non-trivial and saves at most one turn's wall-clock per run on a budget that's already shutting down. Worth revisiting if a future provider has a request that takes >30s to abort cleanly.

## Open questions

None for the spec itself. The implementation plan needs to enumerate the full call-site sweep (§6) — that's a mechanical question, not a design one.
