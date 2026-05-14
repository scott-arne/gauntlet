# PRI-1507 — implementation plan

**Spec:** `docs/superpowers/specs/2026-05-13-shutdown-drain-cancellation-spec.md`
**Linear:** PRI-1507
**Author:** Granny Weatherwax@1f6f7ef0 (Opus 4.7)
**Revisions:** post-Vimes@38527efe plan review (2026-05-13) — fixed multi-pass attach-point bug, made `writeResultFiles` test seam a definite addition, dropped non-existent `runAgent` test seam, added cancelToken cancellation in drainShutdown.

This plan executes the spec in checkpointed steps. Each step is independently testable; commit at every checkpoint marker (`✓`). Run `bun test` for the listed target between steps and at every checkpoint.

---

## Step 1 — Schema bump (v4 → v5) ✓

Pure type-level change; no behavior. Sets up the rest of the work.

**Edit `src/types.ts`:**

- Bump `RESULT_SCHEMA_VERSION` from `4` to `5`. Append the v5 changelog entry to the comment block at the top of the file.
- Extend `VetStatus` with `"errored"`: `export type VetStatus = "pass" | "fail" | "investigate" | "errored";`
- Add optional `error?: { type: string; message: string }` to `VetResult`. Doc comment per spec §5 (open-typed string, consumers tolerate unknown values).

**Edit `src/agent/agent.ts`:**

- Extend the local `buildResult` partial to accept an optional `error` field; pipe it onto the constructed `VetResult` when present.

**Verify:**
```
bun test test/agent/
bun test
```

The build should compile cleanly. Existing tests pass without changes — no call site emits `"errored"` yet, and the new `VetStatus` member is a pure widening.

**Commit:** `types: bump result schema to v5 (errored status + error field) (PRI-1507)`

---

## Step 2 — Wire abort detection into the agent loop ✓

Adds the cancellation primitive at the leaf. Still no shutdown wiring.

**Edit `src/agent/agent.ts`:**

- Add `abortSignal?: AbortSignal` to `AgentOptions`.
- Add an `isAborted` helper inside `runAgent`: `() => options.abortSignal?.aborted === true`.
- Add an `abortedResult` helper that calls `logger.logShutdownSignaled({ turn: turns, reason: String(options.abortSignal?.reason ?? "unknown") })` and returns `buildResult({ status: "errored", summary: ..., reasoning: ..., error: { type: "shutdown_interrupted", message: "interrupted by shutdown signal" } })` per spec §1.
- Insert two abort checks:
  - **(a)** at the top of the `while (Date.now() < deadline)` body, before `logger.logLlmRequest(...)` (`agent.ts:238`)
  - **(b)** at the top of the `for (const tc of response.toolCalls)` body, before `logger.logToolCall(...)` (`agent.ts:339`). Discards the partial `results` array — `pushAssistantTurn(messages, ...)` has run, but the per-turn `results` collection has not been pushed back into `messages` yet, so abandoning it is safe.

**Edit `src/evidence/logger.ts`:**

- Add `logShutdownSignaled(fields: { turn: number; reason: string }): void { this.writeEvent("shutdown_signaled", { ...fields }); }`. Mirror the pattern of `logRunError` directly above it.

**New test `test/agent/abort-signal.test.ts`:**

- Stub `LLMClient.chat` and `Adapter.executeTool` so a turn loop can be driven deterministically.
- Case 1: `abortSignal` is already aborted before turn 1. Assert: returns `errored`, `error.type === "shutdown_interrupted"`, `usage.turns === 0`, transcript contains `shutdown_signaled` event.
- Case 2: `abortSignal` aborts after turn 2's LLM response, before the tool-call iteration begins. Assert: returns `errored` with `usage.turns === 2`; `shutdown_signaled` event present; the tool-call loop body never executed (stub `executeTool` never called for turn 2).
- Case 3: `abortSignal` aborts mid-tool-call sequence in turn 2 (after the first of three tool calls completes). Assert: returns `errored` with `usage.turns === 2`; `executeTool` called exactly once for turn 2.

**Verify:**
```
bun test test/agent/abort-signal.test.ts
bun test test/agent/
bun test
```

**Commit:** `agent: AbortSignal honored at turn + adjacent-tool-call boundaries (PRI-1507)`

---

## Step 3 — Thread `abortSignal` through `executeRunCore` ✓

Connect agent to orchestrator. Still no production wiring; orchestrator just forwards the option.

**Edit `src/runs/orchestrator.ts`:**

- Add `abortSignal?: AbortSignal` to `ExecuteRunCoreOptions`. Doc comment per spec §1 (load-bearing invariant: agent returns synthetic, never throws).
- Forward to `runAgent`'s options object at orchestrator.ts:195.
- **Do not** add abort handling to the orchestrator's catch block. Agent returns synthetic on abort; the success path writes `result.json` as normal.

**Extend `test/runs/orchestrator.test.ts`:**

- New case: orchestrator with an already-aborted signal → real `runAgent` (driven by stub LLMClient + stub adapter) returns synthetic errored result → orchestrator writes `result.json` with `status: "errored"`, closes adapter, detaches logger. Verify on-disk file. This exercises the full success-path stack with a real agent loop, not a substituted one.

**Tripwire dropped from this step.** Step 2 already pins the return-not-throw behavior at the agent layer (the abort tests assert the synthetic return). Adding an orchestrator-level tripwire would require introducing a `runAgent?: typeof runAgent` seam in `ExecuteRunCoreOptions` solely to inject a throw-based substitute — that's over-engineering for a behavior already pinned one layer down. The load-bearing invariant lives in:

- Spec §1's explicit text, and
- Step 2's `test/agent/abort-signal.test.ts` Cases 1–3 (synthetic return, never throw)

If a future refactor breaks the invariant, those tests fail. That's the tripwire.

**Verify:**
```
bun test test/runs/
bun test
```

**Commit:** `orchestrator: forward AbortSignal to runAgent; tripwire for return-not-throw (PRI-1507)`

---

## Step 4 — `ActiveRunRegistry`: AbortController storage ✓

Per-run cancellation state lives in the registry.

**Edit `src/api/active-runs.ts`:**

- Add optional `abortController?: AbortController` to `RunSnapshot` (NOT to `ActiveRunInfo` — internal infrastructure, not part of the public payload; keeps WS snapshot serialization unchanged).
- Add method `attachAbortController(runId: string, ac: AbortController): void` — sets the field on the snapshot if it exists (no-op if missing).
- Add method `abortAll(reason: string): number` — iterates the map; for each snapshot whose `abortController` is set and whose signal is not already aborted, calls `abort(reason)`; returns count fired. Tolerates double-abort (`AbortController.abort` is idempotent on already-aborted signals; `signal.aborted` check avoids redundant work).
- Add method `getAbortController(runId: string): AbortController | undefined` for the run-route caller to attach the signal at register time.

**Extend `test/api/active-runs.test.ts`:**

- `attachAbortController` attaches; `getAbortController` retrieves.
- `attachAbortController` for unknown runId is a no-op (no throw).
- `abortAll` fires exactly once per registered controller; returns the count newly aborted.
- Double-`abortAll` is idempotent: second call returns 0 (only counts controllers transitioning aborted=false → true).
- `abortAll` on a registry containing a run whose controller is already `aborted: true` (simulates: run finished and was about to unregister between `list()` and `abortAll`'s loop) — returns 0 for that run, doesn't throw, doesn't fire abort again.

**Verify:**
```
bun test test/api/active-runs.test.ts
bun test
```

**Commit:** `active-runs: per-run AbortController + abortAll (PRI-1507)`

---

## Step 5 — Wire AbortController into the HTTP run paths ✓

Connect registry to orchestrator. Includes a definite `writeResultFiles` seam addition for the ordering test.

**Add a definite test seam first.** `writeResultFiles` is a direct import at `orchestrator.ts:8` and called at `:210` — there is no seam today.

**Edit `src/runs/orchestrator.ts`:**

- Add `writeResultFiles?: typeof writeResultFiles` to `ExecuteRunCoreOptions`. Doc it as a test seam mirroring `adapterFactory` / `clientFactory`.
- Replace the direct `writeResultFiles(outDir, result)` call at `:210` with `(opts.writeResultFiles ?? writeResultFiles)(outDir, result)`.

**Solo path in `src/api/routes/run.ts`:**

After `registry.register({...})` at `~line 247`, construct `const ac = new AbortController(); registry.attachAbortController(runId, ac);` and pass `ac.signal` into `executeHttpRun({...abortSignal: ac.signal, ...})`.

**Multi-pass path — fix the attach-point ordering bug.**

Today's flow (verified by reading `runRunSet` at `src/runs/run-set.ts:54-87`): `runRunSet` is async but returns the `handle` synchronously after starting `runLoop` as a detached promise. By the time `await runRunSet(...)` resolves, `runLoop`'s first iteration has already invoked the executor up to its first `await` — meaning the executor's `if (registry) registry.setStatus(runId, "running")` has already fired against an empty registry (because the route's `for (const r of handle.runs) registry.register(...)` loop runs *after* `runRunSet` returns). It's a silent no-op today (status stays as default "queued" — minor UI bug), but if we attach the AbortController inside the executor it would also silently no-op, and **`abortAll` would find no controller for any multi-pass attempt — shutdown abort would never fire for multi-pass runs.**

Two ways to fix; pick (B):

- **(A)** Reorder the route to register all runs *before* awaiting `runRunSet`. Possible but requires hoisting run-id generation logic out of `runRunSet` (a refactor outside this ticket's scope).
- **(B)** **Use the existing `onAllRunsKnown` hook on `RunSetConfig` (`run-set.ts:33`).** It fires synchronously in `runRunSet`'s prep phase, *before* `runLoop` is started. From the route handler, pass an `onAllRunsKnown` callback that registers every run + attaches a fresh `AbortController` per run. Then the executor's `setStatus` call works correctly (entry exists), and the AbortController is attached when the executor body begins.

Per-attempt `AbortController`s are stored in a local `Map<runId, AbortController>` on the route handler closure so the executor can pick them up by `runId` to forward `ac.signal` into its `executeHttpRun({abortSignal: ac.signal, ...})` call.

**Edit `src/api/routes/run.ts` `executeHttpRun`:**

- Add `abortSignal?: AbortSignal` to its options. Forward to `executeRunCore`.

**Ordering invariant.** `writeResultFiles` runs at orchestrator.ts:210 *before* `adapter.close` and the wrapper's `afterClose` hook (which calls `registry.unregister`). This is load-bearing for the §3 stub-writer race-safety story. The new ordering test makes it enforceable.

**New test `test/runs/orchestrator-ordering.test.ts`:**

- Inject a `writeResultFiles` substitute (via the new seam) that records `Date.now()` and calls through.
- Inject an `afterClose` hook (via the existing `RunCoreHooks.afterClose` surface) that records `Date.now()`.
- Drive a normal run with stub LLMClient + stub adapter and assert `writeResultFiles_ts < afterClose_ts`.
- Failure message names spec §3 + this plan's Step 5 ("ordering invariant — see PRI-1507 spec").

**Update `test/api/run.test.ts`:**

- Solo path: assert `registry.getAbortController(runId)` returns a defined controller after `POST /api/run/:id`.
- Multi-pass path: assert `getAbortController` returns defined controllers for every run in the set after `POST` (this is the regression test for the attach-point bug).

**Verify:**
```
bun test test/api/run.test.ts
bun test test/runs/orchestrator-ordering.test.ts
bun test
```

**Commit:** `api: per-run AbortController via onAllRunsKnown; writeResultFiles seam (PRI-1507)`

---

## Step 6 — Extend `drainShutdown` with abort + patience + stub ✓

The wiring this whole spec exists for. Includes a `cancelTokens` cancellation hook to close the run-set-loop race (Vimes #5).

**Edit `src/api/run-cancel.ts`:**

- Add method `cancelAll(): number` to `CancelTokenRegistry` — sets `cancelled = true` on every registered token; returns count newly cancelled. Idempotent (counts only transitions).

**Edit `src/api/shutdown.ts`:**

- Extend `DrainShutdownOptions`:
  - `registry: RegistryLike` already exists. Strengthen the `RegistryLike` interface here to include `abortAll(reason: string): number` and `list()` of `ActiveRunInfo` (with `id`, `startedAt`, optional `runSetId`).
  - Add `cancelTokens?: { cancelAll(): number }` — optional so existing single-pass tests don't need to wire one up. Production always passes one.
  - Add `resultsRoot: string` — directory where per-run dirs live.
  - Add `postAbortMs: number` — patience window (default 1000 in the index.ts caller).
- Extend `DrainResult`:
  - Add `aborted: number` (count returned by `abortAll`)
  - Add `stubbed: number` (count written by the stub writer; 0 when path didn't reach it)
- Refactor the existing while-loop into a `pollUntilEmpty(deadlineMs): number` helper returning `remaining`. Call it twice — once for the grace window, once for the patience window.
- After the grace-window poll, if `remaining > 0`:
  1. Call `cancelTokens?.cancelAll()` first — gates the run-set loop from starting any further attempts (the run-set loop checks `cancelToken.cancelled` between attempts at `run-set.ts:103`). Without this, a multi-pass set whose attempt 1 gets aborted via AbortController would happily start attempt 2 *during* the patience window, race-conditioning with the stub writer.
  2. Call `registry.abortAll("shutdown")`, log count.
  3. Call `pollUntilEmpty(now + postAbortMs)` for the patience window.
  4. If still `remaining > 0`, call `writeShutdownStubs(registry.list(), resultsRoot)`, log count.

**Edit `src/index.ts`:**

- Pass the existing `cancelTokens` registry into `drainShutdown` in the serve-case shutdown handler.

**Update `test/api/shutdown.test.ts`:**

- The existing tests pass a stub registry that doesn't implement `abortAll`. Extend the stub to satisfy the new `RegistryLike` (no-op `abortAll` returning 0 is fine for the existing clean-drain cases). Existing assertions stay valid.

**New module `src/api/shutdown-stub-writer.ts`** (separate file because it's distinct concern + cleanly testable in isolation):

- Export `writeShutdownStubs(runs: ActiveRunInfo[], resultsRoot: string): number`.
- For each run, build the stub path: `join(resultsRoot, run.id, "result.json")`.
- If `existsSync(stubPath)` → skip (the agent loop won the patience-window race; their result is the truth).
- Otherwise, write the stub per spec §3, with `duration_ms = run.startedAt ? Date.now() - run.startedAt : -1`. `JSON.stringify(stub, null, 2)`.
- Return count actually written.

**Edit `src/index.ts`:**

- Pass `resultsRoot: gauntletPath(config.projectRoot, "results")` and `postAbortMs: 1000` into the existing `drainShutdown` call inside the `installShutdownHandlers` callback.

**New test `test/api/shutdown-cancel.test.ts`:**

- Test seams: stub `RegistryLike` (with controllable `abortAll`), stub `cancelTokens` (with controllable `cancelAll`), in-memory results dir (use `fs.mkdtempSync` in `beforeEach`).
- Case 1 (clean drain): registry empty after `pollMs * N` < `graceMs`. Assert: `drainedCleanly: true`, `aborted: 0`, `stubbed: 0`. `cancelAll` not called.
- Case 2 (abort cleanly observed): registry has 2 runs; after `graceMs`, registered fake AbortControllers are wired so that aborting them removes the run from the registry within `postAbortMs`. Assert: `drainedCleanly: false`, `aborted: 2`, `stubbed: 0`, `cancelAll` called once.
- Case 3 (stub fallback): registry has 2 runs; aborting them does NOT remove from registry (simulates an agent loop that's truly stuck). Pre-write `result.json` for one of them (simulates the patience-window-race winner). Assert: `aborted: 2`, `stubbed: 1` (only the run with no `result.json` got stubbed); the existing file was not overwritten (asserted by content).
- Case 4 (zero in-flight): registry empty at signal time. Assert: clean exit, no abort attempt, no cancelAll.
- Case 5 (multi-pass run-set): registry has attempt-1 of a 3-pass set; after grace, abort fires; the test's stub run-set machinery would-have-started attempt 2 inside the patience window, but `cancelAll` is checked first by the stub run-loop and the next attempt never starts. Assert: `cancelAll` returned 1, no second-attempt registration appears in the registry.

**Verify:**
```
bun test test/api/shutdown-cancel.test.ts
bun test test/api/shutdown.test.ts
bun test
```

**Commit:** `shutdown: abort + patience + stub writer for grace-expired runs (PRI-1507)`

---

## Step 7 — Run-set rollup: include errored result data in medians ✓

Per spec §6 + AC#7.

**Edit `src/evidence/run-set-writer.ts` `summarizeCard`:**

- Replace the `if (r.status === "errored") { byStatus.errored++; continue; }` block with:
  ```ts
  if (r.status === "errored") {
    byStatus.errored++;
    const result = lookup(r.runId);
    if (result) {
      if (result.usage?.turns != null) turns.push(result.usage.turns);
      if (result.duration_ms != null) durations.push(result.duration_ms);
    }
    continue;
  }
  ```
- Behavior preserved for catch-path errored entries (lookup returns null → no push).
- Behavior new for v5 errored entries with on-disk result.json (lookup returns the parsed result → usage included in medians).

**New test `test/runs/run-set-aggregate.test.ts`** (or extend existing run-set test if there's an obvious one):

- Case A (catch-path errored): `recordRunEnd("...", "errored")` followed by finalize where lookup returns null. Assert `byStatus.errored === 1`, `medianTurns === 0` (empty samples).
- Case B (v5 errored with result): `recordRunEnd("...", "errored")` followed by finalize where lookup returns a `VetResult` with `status: "errored"`, `usage.turns: 7`, `duration_ms: 5000`. Assert `byStatus.errored === 1`, `medianTurns === 7`, `medianDurationMs === 5000`.
- Case C (mixed): two `pass` (3 turns, 5 turns), one `errored` with usage (4 turns), one `errored` without (catch path). Assert `byStatus = { pass: 2, errored: 2, ... }`, `medianTurns === 4` (samples: 3, 4, 5; median is 4).

**Verify:**
```
bun test test/runs/
bun test
```

**Commit:** `run-set-writer: include errored result usage in medians when present (PRI-1507)`

---

## Step 8 — `VetStatus` call-site sweep ✓

Mechanical. Each consumer of `VetStatus` gets an `errored` arm.

**Sweep target:** every file that switches on `VetStatus` or pattern-matches on the literal strings `"pass"`/`"fail"`/`"investigate"`. Initial list from `grep`:

| File | What to add |
|------|-------------|
| `src/cli/stream/batch-table.ts` | Errored row glyph + color (suggest `✗` red, distinct from `!` for investigate; pick what looks right against the existing `✓ ! ⠋` palette) |
| `src/cli/stream/pretty.ts` | Status-badge rendering for errored |
| `src/runs/aggregate.ts` | `deriveBucket` already has `errored` arm; verify `mixed_with_errors` semantics still make sense after v5; no code change expected, but a comment update naming v5 |
| `src/api/routes/run.ts` | Terminal broadcast event shape: ensure `errored` flows through `complete` event without erroring out a switch |
| `ui/src/components/RunsList.tsx` | List row badge |
| `ui/src/components/RunDetail.tsx` | Detail header status pill |
| `ui/src/components/LiveRun.tsx` | Live status badge |
| `ui/src/components/transcript/RunEndPanel.tsx` | Verdict panel rendering |
| `ui/src/components/transcript/TranscriptView.tsx` | Whatever switches on status |
| `ui/src/lib/api.ts` | Type plumbing for the `error` field if the front-end consumes it |

**Conventions for new arms:**
- CLI: red glyph (e.g. `✗`), label "ERR" or "interrupted"
- UI: red-or-grey treatment; a tooltip surface for `error.message` would be nice but is not load-bearing for AC

**For each file: open, find the switch (or string compare), add the new arm, run that file's targeted test (if one exists).**

After the full sweep:
```
bun test
bun run build:ui  # type-check the UI
```

**Commit:** `ui+cli: render "errored" verdict (PRI-1507)`

---

## Step 9 — Documentation: `docs/format.md` ✓

Per spec §8 + AC#6.

**Edit `docs/format.md`:**

- In the `run.jsonl` events bullet (around line 18), add `shutdown_signaled` to the events list.
- In the `result.json` example block (around line 80), no change needed unless we want to show an `error` field example. Leave the example showing the common pass case.
- In the "Fields" subsection (line 112+), update `status` from `"pass" | "fail" | "investigate"` to add `"errored"`. Add a new bullet documenting the `error` field shape per spec §5 (open-typed `type`, document `"shutdown_interrupted"` as today's only emitter).
- In `### Schema versioning` → `### Changelog`, add v5 entry above v4: `Added "errored" to VetStatus and optional error: {type, message} field. Today the only emitter is shutdown drain (PRI-1507). For shutdown-stub results, duration_ms uses -1 as a sentinel meaning "registry entry was missing startedAt at stub time" (rare).`
- In the `shutdown_signaled` event entry: note that `turn` may be `0` if abort was already set when the agent loop began (e.g., shutdown signal arrived between `executeRunCore` start and the loop's first iteration).

**Verify:**
- Manual read-through of `docs/format.md` for consistency
- No test runs the doc file, but `bun test` should still be clean

**Commit:** `docs(format): document errored status, error field, shutdown_signaled event, v5 (PRI-1507)`

---

## Step 10 — Final verification + AC walkthrough ✓

Walk every acceptance criterion against the actual implementation:

- **AC#1a (abort observed)**: covered by `test/api/shutdown-cancel.test.ts` Case 2 + `test/agent/abort-signal.test.ts`
- **AC#1b (stub fallback)**: covered by `test/api/shutdown-cancel.test.ts` Case 3
- **AC#2 (`shutdown_signaled` event)**: covered by `test/agent/abort-signal.test.ts` (path (a) only — qualified)
- **AC#3 (`/api/results/:runId` returns 200)**: a manual integration check via `gauntlet serve` + manual POST + SIGTERM is the highest-confidence verification; consider adding an integration test that does a real `executeHttpRun` with a stubbed slow agent, sends SIGTERM, then checks `GET /api/results/:runId` returns 200.
- **AC#4 (patience-window winner)**: covered by `test/api/shutdown-cancel.test.ts` Case 3 (the pre-existing `result.json` is preserved)
- **AC#5 (writeResultFiles before unregister)**: covered by `test/runs/orchestrator-ordering.test.ts`
- **AC#6 (schema + docs)**: read `RESULT_SCHEMA_VERSION === 5` in `src/types.ts`; read `docs/format.md` v5 changelog
- **AC#7 (rollup includes errored usage)**: covered by `test/runs/run-set-aggregate.test.ts` Case B + C
- **AC#8 (UI/CLI handle errored)**: visual check of `gauntlet batch` output with a stubbed errored run (or rely on the unit-test additions in Step 8 for each renderer)
- **AC#9 (registry empty before server.stop)**: assert in `test/api/shutdown-cancel.test.ts` Case 2 + 3 — registry empty after `drainShutdown` returns
- **AC#10 (full bun test green)**: `bun test`

**Final commands:**
```
bun test
bun run build:ui  # type-check
```

**Final commit (if any sweep cleanup):** `test: PRI-1507 verification harness`

---

## Branching + integration

Per Matt's `feedback_no_prs.md`: no PRs. After Step 10's clean test run, merge `main` → `main` (we're already on main; commits stack directly). Update Linear PRI-1507 to **In Review** when the work is structurally complete (do not move to Done — that's Matt's call per `feedback_linear_never_close_tickets.md`).

## Risk / open considerations

- **Step 5's ordering invariant test** is the single most important test in this plan. If it gets dropped or weakened, the entire stub-writer race-safety story collapses silently. Treat any future PR that touches the ordering test as a load-bearing review.
- **Step 6's stub writer existsSync** is intentionally cheap. The full safety argument depends on Step 5's invariant. A defensive richer alternative (atomic temp-file rename, fsync) would only matter if the agent and the stub writer were ever truly concurrent, which the wrapper's `afterClose` ordering precludes.
- **Step 8's UI sweep** could be deferred to a follow-up if it bloats this branch; the back-end work is independently shippable. But AC#8 explicitly requires UI handling, so deferring means amending the AC. Recommend keeping it inline.
