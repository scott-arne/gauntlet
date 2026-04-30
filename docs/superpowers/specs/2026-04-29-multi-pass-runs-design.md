# Multi-pass runs — design

**Status:** approved by Matt 2026-04-30. Open questions resolved (see "Resolved decisions" near the end). Ready for the implementation plan.
**Author:** Mosscap (Bob 320e9b00/Opus 4.7)
**Linear:** [PRI-1440](https://linear.app/prime-radiant/issue/PRI-1440)
**Related:** PRI-1382 (CLI batch), `src/cli/run-one.ts`, `src/cli/batch.ts`, `src/api/routes/run.ts`, `src/api/ws.ts`, `src/api/active-runs.ts`, `src/util/id.ts`, `src/types.ts`, `src/evidence/writer.ts`, `ui/src/components/NewRunModal.tsx`
**Companion recon:** Raven, 2026-04-29 (in-conversation, not committed)
**Spec review:** Tarquin, 2026-04-29 (in-conversation, applied below)

---

## Problem

Gauntlet is an LLM-driven e2e testing tool. Each `gauntlet run` exercises the
SUT through a non-deterministic agent: the same story can pass on attempt 1,
fail on attempt 2, surface a different fail mode on attempt 3. That variance
is signal — sometimes more useful than a single pass/fail verdict — but the
tool today treats every run as a one-shot.

The only way to repeat a story is to invoke `gauntlet run` (or click "New
Run") N times by hand and read N independent result directories. A batch
run can only run *different* cards, never the same card twice. There is no
first-class concept of "run this card N times and tell me how it behaved
across the set."

We want to embrace stochasticity as part of the test signal. Same story, N
attempts, one aggregated answer.

## Goal

Add a `passes` dimension to both Single Run and Batch Run. One invocation
produces N independent runs of the same card (Single) or N runs of every
card (Batch), grouped under a stable identity, with an aggregated summary
on top of the per-pass results.

Per-pass runs continue to write to the same on-disk layout that exists
today. The new entity is the *group* — a `RunSet` — that sits above one or
more individual runs.

### In scope (v1)

- A `RunSet` entity with stable identity, persisted to disk.
- `--passes N` flag on `gauntlet run` (and same on `gauntlet batch`).
- `passes` field in `POST /api/run/:id` and the web UI's New Run modal.
- Aggregated summary across passes: per-status counts, derived "set status",
  median turns / median duration. Written to disk and exposed to the UI.
- CLI rendering: extend `BatchTableRenderer` to show one row per pass and
  one rollup row per card.
- Web UI: a Run Set view at `/run-sets/:id` showing all constituent passes
  side-by-side, with links into each pass's existing live and post-hoc
  views. Existing `/runs/:id` views are unchanged.

### Out of scope (v1)

- **Concurrent passes.** v1 runs passes strictly serially within a card.
  See Concurrency section.
- **Cross-run-set comparison.** Showing "this card across the last K run
  sets" is a follow-on.
- **Statistical analysis beyond medians and counts.** No per-observation
  diffing across passes, no "which screenshots differ", no LLM-driven
  variance summary. Could be a follow-on once the data exists.
- **Re-running just the failures.** "Re-run the failures from this set"
  is a feature suggested by the UI but deferred.

## Decisions (summary)

> Reflects Matt's answers from 2026-04-30. The "Open Questions"
> section that previously sat at the end of this doc has been
> replaced by "Resolved decisions" — same numbering, with each Q
> stamped with the chosen answer.

- **New entity: `RunSet`.** A RunSet is a *non-trivial* group of runs
  produced by one invocation: passes > 1, or cards > 1, or both. A
  solo `gauntlet run story.md` (1 card × 1 pass) does **not** produce
  a RunSet — it is byte-identical to today. The UI and tooling only
  see the RunSet affordance when it adds something. (See "Why not
  one-RunSet-per-invocation" below.)
- **`--passes N` flag** on `run` and `batch`, default 1. `1` means
  today's behavior — no aggregate view, no extra disk artifacts, no
  changes to `result.json`.
- **Serial within a card; card-major within a batch.** v1 runs all N
  passes of `card[0]` serially, then all N passes of `card[1]`, etc.
  This iteration order is part of the v1 contract — concurrency v2
  may interleave (see Concurrency section).
- **Per-pass evidence is unchanged.** Each pass writes to its own
  `<.gauntlet>/results/<runId>/` exactly as today. The per-run
  `result.json` shape is unchanged for solo runs and gains an
  optional `runSet` field for runs that are part of a RunSet.
- **New on-disk artifact (RunSets only): `<.gauntlet>/run-sets/<runSetId>/`.**
  Holds `set.json` (manifest, includes the ordered runs list and the
  computed summary block) and `summary.md` (human readable). Disk
  linkage from set → runs is by runId in `set.json`.
- **Reverse pointer in `result.json` (RunSets only):** runs that
  belong to a RunSet gain an optional `runSet` field
  (`{ runSetId, kind, passes, cards, cardIndex, attemptNumber }`).
  Solo runs omit the field entirely.
- **Aggregate status is a derived field**, not a stored verdict.
  Computed from the constituent statuses on read. v1 buckets:
  `consistent_pass`, `consistent_investigate`, `consistent_fail`,
  `mixed`, `mixed_with_errors`, `errored`. (See Aggregation policy.)
- **Field naming inside `summary`:** `cardStatus` per-card,
  `overallStatus` at the top. Same bucket vocabulary in both.
- **Cancellation is in scope for v1.** Both CLI (SIGINT) and Web
  (`DELETE /api/run-sets/:runSetId` and `DELETE /api/runs/:runId`)
  abort the in-flight attempt cleanly, skip remaining attempts, and
  finalize the set. Cancelled attempts are recorded as `errored` with
  reason `cancelled`. See Cancellation section.
- **No new exit-code semantics yet.** `gauntlet run --passes 3` exits
  `0` iff every attempt is `pass`; otherwise `1`. Same rule as batch.
  CLI cancel via SIGINT exits `130` (UNIX convention).
- **No `result.json` schema-version bump.** The `runSet` field is an
  optional additive change. Readers written for the current schema
  parse the new shape correctly (they ignore unknown fields).
- **`runSet` lives on `VetResult`.** The TypeScript type gains an
  optional `runSet?: RunSetCtx` field. The orchestrator stamps it
  onto the result before `writeResultFiles` runs.
- **Web UI scope is intentionally minimal in v1.** A broader UI
  overhaul (transcripts, live runs, run sets unified) is anticipated
  separately. v1 ships only what's needed to make multi-pass usable:
  a `passes` field in NewRunModal, a basic `/run-sets/:id` page, a
  cancel button, and a small badge on existing run rows. No row
  collapsing in `RunsList`, no "rerun failures," no multi-pass
  affordances on `/runs/:id`.

## Identity and naming

```
RunSet                 — only created for non-trivial groupings
                         (passes > 1 or cards > 1).
  ├ runSetId           — primary key. <kind>_<YYYYMMDDTHHMMSSZ>_<nonce>
  │                       where kind ∈ {single, batch}.
  ├ passes             — N (>= 1)
  ├ cards              — list of cardIds (length 1 for single, >=1 for batch)
  └ runs[]             — runIds in deterministic order
                          (cardOrder × attemptOrder)

Run                    — unchanged from today. May gain one optional field:
  ├ runId              — unchanged. <cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>
  └ runSet?            — { runSetId, kind, passes, cards, cardIndex,
                          attemptNumber }
                         Only present when this run is part of a RunSet.
```

`runSetId` format: `single_<ts>_<nonce>` or `batch_<ts>_<nonce>`. Generated
once when the CLI command parses or the API receives the request, before
any pass is dispatched. `attemptNumber` is 1-indexed; `passes` is the total.

The `kind` prefix exists so the id tells you whether this is a 1-card or
N-card grouping without a manifest read. `single` ⇒ `cards.length === 1`
and `passes > 1`. `batch` ⇒ `cards.length > 1` (and `passes >= 1`).

**Naming note: pass vs attempt.** "Pass" is overloaded here — it's both
the user-facing flag (`--passes 3`, what Matt asked for) and a possible
`VetStatus` (`pass | fail | investigate`). To avoid `attempt 1/3 → pass`
becoming `pass 1/3 → pass` in CLI output and code, the spec uses
**`attemptNumber`** as the per-run counter and **"attempt N/M"** in CLI
rendering, while keeping **`--passes N`** as the user-facing flag (Matt's
word). Resolved 2026-04-30: keep `--passes` as the flag.

**Timestamp note:** `runSetId.ts` is the orchestrator start time;
per-attempt `runId.ts` is each attempt's own start. So
`runSetId.ts <= runs[0].ts`, and listings sorted by timestamp will
group correctly. All timestamps are UTC, second-resolution; the nonce
disambiguates collisions.

## On-disk layout

```
<.gauntlet>/results/                              # unchanged
  <runId>/
    result.json                                   # gains optional runSet field
    result.md                                     #   (only when part of a RunSet)
    run.jsonl
    inputs/...
    screenshots/...
    issues/...

<.gauntlet>/run-sets/                             # NEW (only for RunSets)
  <runSetId>/
    set.json                                      # canonical manifest + summary
    summary.md                                    # human-readable rollup
```

`set.json` schema (v1):

```jsonc
{
  "schemaVersion": 1,
  "runSetId": "single_20260429T235959Z_abcd",
  "kind": "single" | "batch",
  "createdAt": "2026-04-29T23:59:59Z",
  "completedAt": "2026-04-30T00:14:22Z" | null,
  "passes": 3,
  "cards": ["login-ok"],
  // Eagerly populated at orchestrator start. All runIds known up
  // front (see "API surface" — no TBD placeholders).
  "runs": [
    { "runId": "login-ok_20260429T235959Z_a1b2", "cardId": "login-ok", "attemptNumber": 1 },
    { "runId": "login-ok_20260430T000022Z_c3d4", "cardId": "login-ok", "attemptNumber": 2 },
    { "runId": "login-ok_20260430T000051Z_e5f6", "cardId": "login-ok", "attemptNumber": 3 }
  ],
  // Computed at finalize() and rewritten in place.
  "summary": {
    "perCard": [
      {
        "cardId": "login-ok",
        "passes": 3,
        "byStatus": { "pass": 2, "fail": 0, "investigate": 1, "errored": 0 },
        "cardStatus": "mixed",
        "medianTurns": 6,
        "medianDurationMs": 4210
      }
    ],
    "overall": {
      "totalRuns": 3,
      "byStatus": { "pass": 2, "fail": 0, "investigate": 1, "errored": 0 },
      "overallStatus": "mixed"
    }
  }
}
```

Per-run additions to `result.json` (no schema-version bump — additive
optional field):

```jsonc
{
  // ...existing fields...
  "schemaVersion": 2,                              // unchanged
  "runSet": {                                      // optional, present
    "runSetId": "single_20260429T235959Z_abcd",   //   only when this run
    "kind": "single",                             //   is part of a RunSet
    "passes": 3,
    "cards": ["login-ok"],
    "cardIndex": 0,
    "attemptNumber": 2
  }
}
```

**Why not one-RunSet-per-invocation?** An earlier draft proposed every
run carry a RunSet (size 1 for solo runs) so the UI never special-cased
"solo run." Tarquin's review (F1) pointed out this contradicted itself,
created on-disk noise for users who never use multi-pass, and forced a
schema bump. Resolution: solo runs stay solo. The UI's special case is
one `if (run.runSet)` check; the disk impact is zero for users who don't
use the feature.

## CLI surface

`gauntlet run`:

```
gauntlet run <story.md> --target <url> [flags]
  ...existing flags...
  --passes <n>           Run the same card N times. Default: 1.
                         When > 1, output includes a per-pass table
                         and an aggregated summary; the run set is
                         persisted under <.gauntlet>/run-sets/<id>/.
```

`gauntlet batch`:

```
gauntlet batch <story1.md> [story2.md ...] --target <url> [flags]
  ...existing flags...
  --passes <n>           Run each card N times. Default: 1.
                         The batch produces one run set with cards × passes
                         total runs, executed serially.
```

Validation: `--passes 0` is a usage error. `--passes` must be a positive
integer. v1 ships with a soft cap of 50 (see Concurrency).
`--concurrency K` is a v2 follow-on (resolved Q6).

CLI output, multi-pass single run (default TTY mode), `--passes 3`.
"attempt N/M" deliberately avoids saying "pass" so it doesn't collide
with the `VetStatus = pass` verdict on the same line:

```
Gauntlet · login-ok · 3 attempts · target https://app.local

  ✓  attempt 1/3   pass          6 turns · 4.2s
        → /Users/mw/.gauntlet/results/login-ok_…_a1b2/
  !  attempt 2/3   investigate   9 turns · 8.1s
        → /Users/mw/.gauntlet/results/login-ok_…_c3d4/
  ⠋ [3/3] attempt 3/3   turn 4 / 50

run set: 1 pass · 0 fail · 1 investigate · 0 errored · mixed
set: <.gauntlet>/run-sets/single_…_abcd/
```

CLI output, batch with passes (default TTY mode),
`gauntlet batch a.md b.md --passes 2`:

```
Gauntlet · 2 cards × 2 attempts · target https://app.local

  ✓  login-ok          attempt 1/2   pass         6t 4.2s
  ✓  login-ok          attempt 2/2   pass         5t 3.9s
        → consistent_pass · median 5.5t / 4.0s
  ✗  login-locked-out  attempt 1/2   fail        10t 9.7s
  ⠋ [4/4] login-locked-out  attempt 2/2   turn 3 / 50
```

The per-card rollup is **part of the final attempt's commit** for that
card — it's the third permanent line written when
`attemptNumber === passes` (see Architecture §4 for why this matters
for the renderer's "result lines never move once written" invariant).
Batch overall summary at end mirrors today's batch summary plus a
"mixed / consistent / errored" breakdown.

`--silent` and `--format jsonl` interactions inherit batch mode's
contract. In jsonl mode, every per-attempt event is emitted with
both `runId` and (when in a RunSet) `runSetId` injected. There is
also one additional event class:

```
{ "kind": "run_set_summary", "runSetId": "...", ...summary block... }
```

emitted once at the end of the invocation (after the last
`run_end`).

## API surface

`POST /api/run/:id` body extension:

```jsonc
{
  // ...existing fields...
  "passes": 3   // optional, default 1
}
```

Response shape — **always** the new shape (back-compat: solo invocations
return a one-element `runs` array with `runSetId: null`). All N runIds
are generated eagerly at orchestrator start and embedded in the
response; no `TBD` placeholders.

```jsonc
// passes > 1 (RunSet)
{
  "runSetId": "single_20260429T235959Z_abcd",
  "kind": "single",
  "passes": 3,
  "runs": [
    { "runId": "login-ok_20260429T235959Z_a1b2", "attemptNumber": 1, "status": "running" },
    { "runId": "login-ok_20260429T235959Z_c3d4", "attemptNumber": 2, "status": "queued"  },
    { "runId": "login-ok_20260429T235959Z_e5f6", "attemptNumber": 3, "status": "queued"  }
  ]
}

// passes === 1 (solo, no RunSet)
{
  "runSetId": null,
  "kind": "single",
  "passes": 1,
  "runs": [
    { "runId": "login-ok_20260429T235959Z_a1b2", "attemptNumber": 1, "status": "running" }
  ]
}
```

The UI updates atomically — the response shape is uniform regardless of
`passes` value, no two-shape branch.

Eager runId generation: `makeRunId(cardId)` already includes a random
nonce, but the orchestrator generates all N at once. To eliminate any
timestamp-collision risk during a fast loop, the orchestrator uses one
base timestamp and embeds the attempt number into the nonce as a
prefix (e.g. `a1b2`, `a2c3`, `a3d4`) so attempts within a set are
guaranteed distinct without needing different `Date.now()` reads. Cross-set
collisions remain handled by the random portion of the nonce.

New endpoints:

- `GET /api/run-sets/:runSetId` — full manifest (`set.json`).
- `GET /api/run-sets/:runSetId/summary` — just the `summary` block
  (cheap polling endpoint while the set is in flight).
- `GET /api/run-sets?cardId=<id>&limit=...` — list of recent run sets
  for a card. (Optional in v1 — UI is intentionally minimal.)

WebSocket: each pass continues to broadcast on its own per-`runId`
channel. There is a new top-level event the UI can subscribe to keyed
by `runSetId`:

```
ws://.../api/ws/run-sets/<runSetId>
```

Emits:

```
{ kind: "pass_start", runSetId, runId, attemptNumber, passes }
{ kind: "pass_end",   runSetId, runId, attemptNumber, finalStatus }
{ kind: "set_done",   runSetId, summary }
```

The per-pass `runs/live/:runId` WS channel is unchanged. The set-level
WS exists so the Run Set view can render progress without subscribing
to all N pass channels at once.

## Web UI

**New Run modal.** Adds a numeric input "Passes" (default 1) below the
existing turns/viewport row. When `passes > 1` and submit succeeds:
navigate to `/run-sets/:runSetId` instead of `/runs/live/:runId`.

**`/run-sets/:runSetId` view.** New page. Layout:

```
┌─ Run Set login-ok · 3 passes ─────────────────────────────┐
│ overall: 1 pass · 0 fail · 1 investigate · 0 errored      │
│ set status: mixed · median 6 turns · median 5.4s          │
├───────────────────────────────────────────────────────────┤
│ pass 1/3   ✓ pass          6 turns · 4.2s     [view] [transcript]
│ pass 2/3   ! investigate   9 turns · 8.1s     [view] [transcript]
│ pass 3/3   … running       turn 4 / 50        [watch live]
└───────────────────────────────────────────────────────────┘
```

For `kind: "batch"`, the layout groups by card:

```
┌─ Batch · 2 cards × 2 passes ──────────────────────────────┐
│ overall: 3 pass · 1 fail · 0 investigate · 0 errored      │
├ login-ok ─────────────────────────────────────────────────┤
│ pass 1/2  ✓ pass · 6t · 4.2s                              │
│ pass 2/2  ✓ pass · 5t · 3.9s                              │
│ rollup:   consistent_pass · median 5.5t / 4.0s            │
├ login-locked-out ─────────────────────────────────────────┤
│ pass 1/2  ✗ fail · 10t · 9.7s                             │
│ pass 2/2  … running · turn 3 / 50                         │
└───────────────────────────────────────────────────────────┘
```

Each pass row links to its `/runs/:runId` (post-hoc) or
`/runs/live/:runId` (live) view. The set view is the only new screen;
all per-pass screens are reused as-is.

**Run Again from a pass-set.** "Run Again" on `/run-sets/:id` prefills
the modal with the same `passes` count. (Out of v1 scope: "rerun
just the failed passes" or "rerun with passes+1"?)

**Sidebar / runs list.** When `RunsList` shows runs that belong to a
RunSet of size >= 2, the row shows a small badge: `pass 2/3 · set abc…`,
clickable to the set view. v1 does not collapse pass-set rows in the
list. v1 does not collapse rows in `RunsList`.

## Architecture

The serial-loop pattern from `src/cli/batch.ts` already implements
"run multiple cards once each, observe each, table on top." The
multi-pass extension builds on the same shape, but the seam has to
work on **both** call paths — the CLI's `runOne` (`src/cli/run-one.ts`)
*and* the API's `executeRun` (`src/api/routes/run.ts`). Today these
are parallel implementations: `runOne` is a synchronous wrapper, while
`executeRun` adds broadcaster, registry, and screencast wiring. The
multi-pass orchestrator drives whichever is appropriate for its caller.

1. **`RunSet` orchestrator** (new module, e.g. `src/runs/run-set.ts`).
   Owns the loop:
   ```
   for cardIndex in 0..cards.length-1:
     for attemptNumber in 1..passes:
       executor(cards[cardIndex], { ...opts, runSetCtx })
   ```
   `executor` is injected — `runOne` for the CLI, `executeRun` for
   the API. The orchestrator's only job is the loop, the ctx
   threading, the writer lifecycle, and error containment.

   - Cards × passes collapses to today's batch loop when `passes === 1`
     and to today's single run when `passes === 1` and
     `cards.length === 1`.
   - When `passes === 1 && cards.length === 1` the orchestrator is
     bypassed entirely — the existing single-run code path runs as
     today, no RunSet, no writer, no extra disk artifacts.

   The orchestrator is invoked from both `src/cli/run.ts` (single-card
   wrapper) and `src/cli/batch.ts` (multi-card wrapper). Each retains
   its thin command surface for argument parsing and renderer wiring;
   the loop body is unified.

2. **`runSetCtx` is the seam through *both* `runOne` and `executeRun`.**
   Both call sites grow an optional parameter:

   ```ts
   interface RunSetCtx {
     runSetId: string;
     kind: "single" | "batch";
     passes: number;
     cards: string[];          // cardIds, in order
     cardIndex: number;
     attemptNumber: number;
   }

   // src/cli/run-one.ts
   runOne(opts: RunOneOpts & { runSetCtx?: RunSetCtx }): Promise<RunSummary>;

   // src/api/routes/run.ts
   executeRun(opts: ExecuteRunOpts & { runSetCtx?: RunSetCtx }): Promise<void>;
   ```

   Both call paths route to `evidence/writer.ts`'s `writeResultFiles`,
   which is unchanged — the `runSet` field rides along on the
   `VetResult` itself. Concretely, `src/types.ts` gains:

   ```ts
   interface VetResult {
     // ...existing fields...
     runSet?: RunSetCtx;       // present when this run is part of a RunSet
   }
   ```

   The orchestrator stamps the ctx onto the result returned from
   `runAgent` before passing it to `writeResultFiles`. This keeps the
   writer dumb (one parameter, one shape) and lets in-process callers
   read `runSet` off the returned result without a JSON round-trip.

3. **`RunSetWriter`** (new module under `src/evidence/`, e.g.
   `evidence/run-set-writer.ts`). Owns the `<.gauntlet>/run-sets/<id>/`
   directory:

   - `start(ctx, allRuns)`: creates the dir; writes the initial
     `set.json` with the eagerly-generated full `runs[]` (every runId
     is known up front, see "API surface") and `summary: null`,
     `completedAt: null`.
   - `recordRunStart(runId, attemptNumber)`: marks that run's status
     in `set.json#runs[i].status = "running"`.
   - `recordRunEnd(runId, finalStatus)`: marks
     `set.json#runs[i].status = finalStatus`. The full per-run details
     remain in `<.gauntlet>/results/<runId>/result.json`.
   - `finalize()`: reads each per-run `result.json`, computes the
     `summary` block, rewrites `set.json` with `completedAt` and the
     summary, writes `summary.md`.

   The writer is created by the orchestrator, not by `runOne` /
   `executeRun`. This keeps the per-run code paths ignorant of
   multi-pass concerns. `set.json` rewrites are full file writes
   (atomic via `fs.writeFile` to a temp + rename) — the file is small
   so this is cheap.

4. **`BatchTableRenderer` extension.** Today the renderer keys rows by
   `cardId`. Extend to key by `(cardId, attemptNumber)` and integrate
   the per-card rollup into the **commit pattern** (so it doesn't
   violate "result lines never move once written"). Concretely:

   ```ts
   class BatchTableRenderer {
     // existing API extends — attemptNumber defaults to 1, passes defaults to 1
     setQueued(cardId, attemptNumber?, passes?): void;
     setRunning(cardId, runId, maxTurns, attemptNumber?, passes?): void;
     onTurn(cardId, turn, attemptNumber?): void;
     setDone(cardId, finalStatus, turn, attemptNumber?): void;
     setErrored(cardId, turn|null, message, attemptNumber?): void;

     // batch-level totals, called once after all cards finish
     setOverall(overall): void;
   }
   ```

   - **Per-card rollup is implicit, not a separate API call.** When
     `setDone`/`setErrored` is called and the renderer notices
     `attemptNumber === passes` for that card, it commits a
     three-line block instead of two: status, run-dir hint, rollup
     line. This extends the existing two-line commit shape and
     keeps the "result lines never move once written" invariant
     intact.
   - The renderer's `pendingBlankAboveSpinner` accounting needs to
     understand a 3-line commit so the next card's spinner positions
     correctly.
   - For `passes === 1` the third line is suppressed and the renderer
     behaves exactly as today.
   - The renderer needs to compute the rollup itself from the per-pass
     records it has already seen — it does *not* read from
     `set.json` (which is still being written). Computing
     `byStatus`/`medianTurns`/`medianDurationMs` over N integers is
     trivial.

5. **HTTP route.** `src/api/routes/run.ts`'s `POST /api/run/:id`
   handler grows a `passes` validator (positive integer; usage error
   for 0; soft cap of 50 — see Concurrency).
   - When `passes > 1`, it generates all N runIds eagerly, builds the
     orchestrator with `executor = executeRun`, returns the new-shape
     `202` response with the full `runs[]`, and detaches the
     orchestrator as a background task.
   - When `passes === 1`, the response is the same shape (one-element
     `runs[]`, `runSetId: null`) and the existing `executeRun`
     codepath runs unchanged.
   - `ActiveRunRegistry` is updated by the orchestrator: all N runs
     are pre-registered with `status: "queued"` at orchestrator start,
     transitioning to `"running"` and then unregistered as each pass
     completes. So `/api/active-runs` surfaces queued attempts in
     addition to the running one (resolved Q8).

6. **WebSocket.** New `RunSetBroadcaster` in `src/api/ws.ts`, parallel
   to `RunBroadcaster` (not derived from it). The orchestrator emits
   set-level events (`pass_start`, `pass_end`, `set_done`) directly
   to the set broadcaster. Per-run events continue to flow through
   `RunBroadcaster` unchanged. Clients subscribe to one or both
   channels independently — the `/run-sets/:id` view subscribes to
   the set broadcaster and to each pass's run broadcaster as needed
   for live transcripts.

## Aggregation policy

Per-card aggregation across N attempts:

| field | computation |
|---|---|
| `byStatus` | count of each VetStatus across the N attempts |
| `cardStatus` | derived bucket (see below) |
| `medianTurns` | median of `usage.turns` across the N attempts |
| `medianDurationMs` | median of `duration_ms` across the N attempts |

The same field at the batch level is named `overallStatus` (in
`summary.overall`). The bucket vocabulary is identical; only the field
name differs to make logs and code unambiguous about which scope is
being described.

Bucket derivation (v1; six buckets):

```
all N pass                                → "consistent_pass"
all N investigate                         → "consistent_investigate"
all N fail                                → "consistent_fail"
all N errored                             → "errored"
mix WITHOUT errored                       → "mixed"
mix WITH errored AND at least one non-errored → "mixed_with_errors"
```

Rationale for splitting `errored`: an errored attempt is usually an
infra blip (Chrome crashed, network dropped) not a SUT signal. A 5-pass
set with 4 passes + 1 errored is `mixed_with_errors`, not `errored` —
that retains the "the SUT mostly passes" signal which would otherwise
be hidden. A set where every attempt errored *is* a useful "stop
running this, the infra is broken" signal, which the dedicated
`errored` bucket preserves.

Pessimism note: a mix of fail + investigate (no pass, no error) lands
in `mixed`, not `consistent_fail`. The earlier draft was pessimistic
about this; Tarquin (F4) caught the inconsistency. Treating it as
`mixed` is the more honest signal.

For `passes === 1` no RunSet exists, so neither field is materialized.
The fields appear only in `set.json`, and `set.json` only exists for
non-trivial groupings.

Batch overall: sum `byStatus` counts across all cards. `overallStatus`
follows the same bucket rules over the totals (e.g. one card all-pass
+ one card all-fail → batch `overallStatus: "mixed"`).

We are explicitly **not** computing means or std-dev in v1. Median is
robust to one-off outliers (one slow attempt dragging the average) and
is enough to support "is this card slower than it used to be." For
`N === 2` the median collapses to the mean of the two values, which
we accept as a degenerate case.

## Concurrency

v1 is **card-major serial**: all attempts of `card[0]`, then all
attempts of `card[1]`, etc. The full ordering is part of v1's contract:

```
card[0].attempt[1] → card[0].attempt[2] → ... → card[0].attempt[N]
  → card[1].attempt[1] → ... → card[1].attempt[N]
  → ... → card[M-1].attempt[N]
```

A soft cap of `passes <= 50` ships in v1 to prevent accidental
1000-attempt invocations.

Concurrency v2 is anticipated but **not** locked in by this spec. Two
viable axes:

- **Across cards, serial within card.** Caps in-flight at
  `cards.length` browsers; preserves the "all attempts of this card
  see similar SUT load" property.
- **Interleaved.** `card[0].attempt[1] → card[1].attempt[1] → ...`,
  giving early-CTRL-C signal across all cards before any one card
  finishes.

v2 may pick either; v1 forecloses neither. The orchestrator's loop
is the only place this knowledge lives.

## Error handling

- **An attempt throws or its run errors:** caught at the orchestrator
  boundary, recorded in the set as `errored` for that attempt, the
  orchestrator continues to the next attempt. Same semantics as
  today's batch on per-card errors.
- **Card path missing or unparseable:** caught before the first
  attempt for that card, all N attempts for that card are recorded
  as `errored before start` in the set, no per-run dirs are created,
  the orchestrator continues to the next card.
- **Orchestrator crash before `finalize()`:** `set.json` is left with
  `completedAt: null` and `summary: null`. A reader can detect this
  and recompute the summary from the `runs[]` pointers if the per-run
  `result.json` files exist. v1 accepts orphan sets; a follow-on
  `gauntlet finalize-set <runSetId>` CLI is the v2 escape hatch (a
  ~20-line addition that reads the per-run results and rewrites
  `set.json` with the computed summary).
- **Cancellation:** see Cancellation section — first-class behavior
  in both CLI (SIGINT) and Web (DELETE endpoint).

## Cancellation

Cancellation is first-class in v1 because a multi-pass invocation can
take long enough that "I want to stop" is a real workflow.

### Shared semantics

Cancel applies at three nested scopes:

1. **An individual attempt** — abort the in-flight `runAgent` loop and
   close the adapter. The attempt's `result.json` is written with
   `status: "errored"` and an extra `errorReason: "cancelled"` field.
2. **A RunSet** — cancel the in-flight attempt (as above) and skip all
   remaining queued attempts. Skipped attempts never get a per-run
   directory; they are recorded in `set.json#runs[i]` with
   `status: "cancelled"` (a synthetic status that lives only in the
   set manifest, not in any `result.json`).
3. **A solo run** — same as cancelling an individual attempt; no
   RunSet involvement.

Set finalization runs as normal after a cancel, with the cancelled
attempts contributing to `byStatus` (see below) and the set's
`overallStatus` derived from whatever did run.

`byStatus` gains a `cancelled` count (in addition to
`pass | fail | investigate | errored`). For `overallStatus` derivation,
cancelled attempts are treated like errored:

```
all N cancelled                                  → "errored"
mix incl. cancelled (with at least one non-error/cancel) → "mixed_with_errors"
```

i.e. `mixed_with_errors` covers both errored and cancelled mixes.
This keeps the bucket count at six. (The set.json's `byStatus` carries
the precise breakdown for anyone who needs to distinguish the two.)

### CLI

`SIGINT` (Ctrl-C) on `gauntlet run` or `gauntlet batch`:

- First Ctrl-C: graceful cancel. Aborts the in-flight attempt via
  `adapter.close()` (the existing `runOne` `finally` already runs),
  marks the attempt `errored` with `errorReason: "cancelled"`, marks
  remaining queued attempts `cancelled` in `set.json`, runs
  `finalize()`, prints the final table, exits `130`.
- Second Ctrl-C within ~2s: hard exit. `process.exit(130)` immediately
  without finalize. The set is left in orphan state; the operator
  knows what they did.

For solo runs (no RunSet), the same first-Ctrl-C behavior applies to
the single in-flight attempt.

### Web

Two new endpoints, both idempotent:

```
DELETE /api/runs/:runId          → cancel a solo in-flight run
DELETE /api/run-sets/:runSetId   → cancel an in-flight run set
```

Behavior:

- Returns `202 ACCEPTED` with `{ status: "cancelling" }` if the
  target was found and is in flight; `404` if not found; `409` if
  already terminal.
- The orchestrator (or `executeRun` for solo) listens on the
  `ActiveRunRegistry` for a `cancelRequested` flag and breaks out of
  its loop after the current attempt's `adapter.close()` completes.
  Same finalize-and-exit path as SIGINT.
- The `RunSetBroadcaster` emits `set_cancelled` (a `set_done`-shaped
  event with the partial summary) so the UI updates.

Web UI: the `/run-sets/:id` page gains a "Cancel" button when the set
is in flight. Confirmation modal, then DELETE, then the page reflects
the cancelled state once the WS event fires. Per-run cancel is also
exposed on the existing live run view via `DELETE /api/runs/:runId`.

### Cancel is not "rerun the failures"

Cancel ends the set. To re-run after a cancel, the user invokes a
new `gauntlet run` / `gauntlet batch` (CLI) or hits "Run Again" (web).
"Re-run just the failed attempts" is still out of scope (resolved Q5).

## Testing

- **Unit:** `RunSetWriter` against scripted run sequences. Cover:
  start → recordRunStart × N → recordRunEnd × N → finalize; partial
  finalize; status derivation; median computation.
- **Refactor guard:** existing single-card `gauntlet run` tests must
  pass unmodified after the orchestrator extraction. Existing
  `gauntlet batch` tests must pass after `BatchTableRenderer`'s
  attemptNumber-aware extension.
- **Integration:**
  - `gauntlet run a.md` (no `--passes`): solo path, no RunSet
    artifact, `result.json` lacks `runSet` field. Byte-identical to
    today.
  - `gauntlet run a.md --passes 3` with the `cli` adapter against a
    stub. Assert: 3 per-run dirs created, one run-set dir, `set.json`
    has 3 runs (eagerly populated), summary computed at finalize,
    exit 0 if all 3 pass.
  - `gauntlet batch a.md b.md --passes 2`. Assert: 4 per-run dirs,
    one run-set dir with 4 runs ordered (a×2, b×2), per-card
    rollups committed in three-line form, batch-level rollup.
  - Mixed status: stub adapter returns `pass`, `pass`, `investigate`
    for `--passes 3` → `cardStatus: "mixed"`.
  - Mixed-with-errors: stub returns `pass`, `pass`, throws on attempt 3
    → `cardStatus: "mixed_with_errors"`, `byStatus: { pass: 2, errored: 1 }`.
    Orchestrator continues past errored attempts; no attempt is
    skipped.
  - All-errored: stub throws on every attempt → `cardStatus: "errored"`.
  - Cancellation: kick off `--passes 5`, send SIGINT after attempt 2
    completes; assert attempt 2 finalized as `pass`/`fail` (whatever
    the stub said), attempts 3–5 marked `cancelled` in `set.json`,
    `overallStatus` derived correctly, exit code `130`.
- **Web:** snapshot test of `/run-sets/:id` with mock data for each
  bucket: `consistent_pass`, `mixed`, `mixed_with_errors`, `errored`,
  in-flight.

## Migration / compatibility

- `result.json` schemaVersion stays at **2** (no bump). The new
  `runSet` field is purely additive and optional; readers written for
  the current schema parse new shapes correctly.
- Old `result.json` files (v1, v2 without `runSet`) remain readable.
  The Run Set views and aggregation are forward-only — running them
  against historical runs is out of scope.
- `gauntlet run <story.md>` with no `--passes` (or `--passes 1`) is
  **byte-identical** to today's invocation. No new directories, no
  new files, no `runSet` field in `result.json`. The on-disk impact
  of this feature is zero for users who don't use it.
- `POST /api/run/:id` response shape changes from `{ runId, cardId }`
  to the new `{ runSetId, kind, passes, runs[] }` shape — applied
  uniformly regardless of `passes` value. The web UI is updated in
  the same change set; no external API consumers exist today.

## Phasing (for the implementation plan)

The spec implies enough scope to break implementation into three
gated commits:

1. **Identity + persistence + orchestrator.** `RunSetCtx` type, the
   orchestrator module, `RunSetWriter`, the optional `runSet` field
   in `result.json` (no schema bump — additive). The seam lands in
   both `runOne` and `executeRun` with the new optional parameter,
   but neither code path's existing callers pass it yet. No CLI
   flag, no API change. Solo runs are byte-identical to today. Unit
   tests on writer + ctx threading. No user-visible behavior change.
2. **CLI surface.** `--passes N` on `run` and `batch`. Extend
   `BatchTableRenderer` for `(cardId, attemptNumber)` keying and the
   three-line commit. Unit + integration tests on the loop. CLI
   users can multi-pass; web UI still does single-attempt.
3. **API + Web UI.** New uniform `POST /api/run/:id` response shape
   (single + multi). `passes` body field. `/api/run-sets/...` routes.
   `RunSetBroadcaster`. `/run-sets/:id` page. NewRunModal field.

If the team wants a tighter v1, phase 3 can ship CLI-only and the
web UI becomes a follow-on.

---

## Resolved decisions

> Resolved by Matt 2026-04-30. Originally drafted as "Open Questions";
> answers are recorded here for the implementation plan and for
> future readers who want to know why the spec lands this way.

- **Q1 — Bucket names:** `mixed` / `mixed_with_errors` ✓ ship as
  proposed.
- **Q2 — Web UI scope:** ship the *minimum* useful surface — modal
  field, basic `/run-sets/:id` page, cancel button, run-row badge.
  No row collapsing, no "rerun failures." A broader UI overhaul
  (transcripts, live runs, run sets unified) is anticipated as a
  separate effort and will redesign these affordances anyway.
- **Q3 — Entity naming:** `RunSet` ✓.
- **Q4 — Flag naming:** `--passes N` ✓ (kept; `attemptNumber` in
  code, "attempt N/M" in CLI output to avoid pass/pass collision).
- **Q5 — "Run Again × N":** out of scope for v1.
- **Q6 — Concurrency:** v1 is card-major serial; `--concurrency K`
  is a localized v2 change to the orchestrator loop.
- **Q7 — `runSet` placement:** on `VetResult` ✓ — Architecture §2
  and "Decisions (summary)" reflect this. The orchestrator stamps
  `runSet` onto the result before `writeResultFiles`; the writer is
  unchanged.
- **Q8 — `/api/active-runs` surfaces queued attempts:** ✓
  pre-register all N attempts at orchestrator start.
- **Q9 — Cancellation:** in scope for v1, both CLI (SIGINT) and Web
  (`DELETE /api/run-sets/:id`, `DELETE /api/runs/:id`). See
  Cancellation section for details — including: cancelled queued
  attempts use a synthetic `cancelled` status in `set.json`, the
  cancelled in-flight attempt records `errored` with
  `errorReason: "cancelled"`, and `mixed_with_errors` covers mixes
  involving cancelled or errored attempts.
- **Q10 — Field naming inside `summary`:** `cardStatus` per-card,
  `overallStatus` at the top ✓.

---

## Next step

The spec is now spec-final. Hand it to `writing-plans` to produce a
three-phase implementation plan matching the Phasing section. Each
phase is a separate commit on `matt/pri-1440-multi-pass-runs` (or its
own branch), gated on the previous phase landing.

If anything in the spec body feels wrong (not just the Qs), call
it out and we can revisit. The decisions aren't precious.

— Mosscap (Bob 320e9b00/Opus 4.7)
