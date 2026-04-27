# CLI multi-story batch — design

**Status:** drafted, awaiting review.
**Author:** Susan Sto Helit (Bob de1643fd/Opus 4.7)
**Related:** `src/cli/run.ts`, `src/cli/args.ts`, `src/cli/stream/`, `src/agent/agent.ts`, `src/api/active-runs.ts`, `src/util/id.ts`

## Problem

`gauntlet run <scenario.md>` runs exactly one card. Iterating on a fanout, or
sweeping a handful of stories at once, means launching N terminals or scripting
a serial loop. There is no first-class way to point Gauntlet at a list of
cards and watch the set progress.

The single-card transcript renderer (`src/cli/stream/pretty.ts`) is built on
the assumption that one run owns stdout — it uses cursor-up and erase-line to
rewrite the most recent tool call inline. Two of those overlapping on one
terminal would scramble both transcripts.

## Goal

A CLI mode that runs N cards in sequence, with one live status table on stdout
showing the state of every card in the set. Per-card evidence on disk is
unchanged from single-card runs.

Out of scope this round:
- Concurrent execution. v1 runs cards strictly serially.
- An interactive multi-card mode that preserves the live transcript per card.
  That's a follow-on design, gated on this one shipping.
- A batch-level aggregated `summary.json` or batch-level results directory.

## Decisions (summary)

- **New subcommand `gauntlet batch`.** Single-card `run` is unchanged.
- **Serial execution in v1.** A future `-j N` / `--concurrency` flag is
  anticipated but explicitly deferred.
- **One status table on stdout.** Per-card pretty/jsonl renderers do not
  attach to stdout in batch mode.
- **`--format jsonl` is the machine-readable mode.** Per-event stream from
  every run, with an injected `runId`.
- **Exit code is binary.** `0` iff every run is `pass`; `1` otherwise.
- **No new evidence layout.** Each card writes to its existing per-run
  directory under `<.gauntlet>/results/<runId>/`.

## CLI surface

```
gauntlet batch <story1.md> [story2.md ...] --target <url> [flags]

  Per-card flags (applied uniformly to every card in the batch):
    --target <url>        (required)
    --adapter <type>      web | cli | tui (default: web)
    --model agent=<name>  Model for the agent
    --chrome host:port    Chrome debugging endpoint
    --turns <n>           Max agent turns per run
    --viewport WxH        Browser viewport
    --save-screencast     Persist screencast frames to disk
    --project-dir <dir>   Project root

  Output flags:
    --format pretty|jsonl Override stream format. Default: auto by TTY.
    --silent              Suppress the table; print only the final summary
                          on stderr. Exit code is the signal.
    --no-color            Disable ANSI color (also respects NO_COLOR).
```

Dropped relative to `run`: `--out`. Each card uses its default per-run
directory; we do not invent a batch-dir layout this round.

Card paths are positional varargs. Shell glob expansion (`gauntlet batch
stories/*.md`) is the intended way to address sets of cards. Zero card
paths is a usage error.

## Architecture

Three changes:

1. **Extract `runOne(card, opts) → Promise<RunSummary>`** from the body
   of `src/cli/run.ts` into `src/cli/run-one.ts`. `opts` carries an
   optional hook
   `onLogger?: (logger: EvidenceLogger) => (() => void)` — invoked once
   immediately after `runOne` constructs its `EvidenceLogger` and before
   the first `runAgent` turn, returning a detach function that `runOne`
   calls in its `finally`. This is the only seam — the logger lifecycle
   stays private otherwise.
   - The single-card `run()` wrapper passes
     `onLogger: (logger) => attachRenderer(logger, streamOpts, sink)`,
     which keeps `attachRenderer` unchanged.
   - `batch.ts` passes its own `onLogger` that subscribes via
     `logger.addEventObserver(...)` and (a) injects `runId` for jsonl
     mode and (b) drives the batch-table state.
   - The wiring around `streamOpts` resolution and the `silent`-branch
     `console.error("runId: ${runId}")` (today at `run.ts:139`) stays in
     the single-card `run()` wrapper, *not* inside `runOne`.
   - The single-card path is otherwise unchanged — this is a refactor
     guarded by the existing single-card tests.

2. **New orchestrator `src/cli/batch.ts`.** Parses each card path, builds a
   per-card options object (per-card flags applied uniformly), iterates
   the cards in order, and `await`s `runOne` for each, passing a per-card
   observer that (a) for `--format jsonl`, writes
   `JSON.stringify({ runId, ...event }) + "\n"` to stdout — runId
   injection happens here, in the observer, *not* inside `JsonlRenderer`
   — and (b) drives the batch-table state for that card. Catches per-run
   errors at the batch boundary so one card's failure does not abort the
   batch. Catches `parseStoryCard` failures *before* `runOne` is called and
   marks that row `errored before start`.

3. **New `BatchTableRenderer` in `src/cli/stream/batch-table.ts`.** Owns
   stdout in batch mode. **Not** a `StreamRenderer` — the existing
   `StreamRenderer` interface is event-driven against an `EvidenceLogger`,
   and queued cards have no logger yet. Instead, exposes a state-push
   interface:

   ```
   class BatchTableRenderer {
     constructor(sink, opts: { isTTY: boolean; color: boolean; columns: number });
     setQueued(cardId: string): void;
     setRunning(cardId: string, runId: string, maxTurns: number): void;
     onTurn(cardId: string, turn: number): void;            // from llm_response
     setDone(cardId: string, finalStatus: VetStatus, turn: number): void;
     setErrored(cardId: string, turn: number | null, message: string): void;
     finalize(): void;  // freezes table, prints summary line
   }
   ```

   `batch.ts` calls these directly. The per-card observer it hands to
   `runOne` translates `run_start` → `setRunning`, `llm_response` →
   `onTurn`, `run_end` → `setDone`, `run_error` → `setErrored`. Per-card
   evidence loggers continue to write to `<runDir>/run.jsonl` exactly as
   today — disk evidence is untouched.

The serve path is untouched. The existing `ActiveRunRegistry`
(`src/api/active-runs.ts`) is the serve-side answer to concurrent runs and
is not consumed by the CLI.

## Status table contract

Per-card model:

```
{
  cardId: string;          // filename stem (basename minus extension)
  runId: string | null;    // assigned at runOne start
  state: "queued" | "running" | "done" | "errored";
  turn: number;
  maxTurns: number;
  finalStatus: VetStatus | null;  // "pass" | "fail" | "investigate"
}
```

v1 uses the filename stem as the row identifier so that queued rows have a
stable key without parsing card bodies up front, and parse-failure rows
have a sensible label. Reading `card.id` from inside the file and using
that as the row label is reserved for a future iteration.

Row format, scaled to terminal width:

```
Gauntlet running in Batch Mode
==============================
  story-id-1       Complete on turn 8 / 20            investigate
  long-story-id-2  Running turn 7 / 20
  story-id-3       (queued)
```

Three columns: `cardId`, status text, result flag. The result flag column
shows the literal `VetStatus` value (`pass` / `fail` / `investigate`) for
completed rows, and `error` for errored rows. The exact layout — column
widths, separators, whether `pass` is dimmed — is iterable; the contract
above is what the renderer is built around.

State machine: `queued → running → done | errored`, plus `queued →
errored` (e.g., card path missing or unparseable — the run never starts).

State → status text:
- `queued` → `(queued)`
- `running` → `Running turn N / MAX`
- `done` → `Complete on turn N / MAX`
- `errored` (after start) → `Errored on turn N`
- `errored` (before start) → `Errored before start`

Initial frame: the table is rendered once with every card as `(queued)`
before the first `runOne` is awaited, so the user sees the full set
immediately.

Redraw model (selected by the `isTTY` argument the renderer is constructed
with — `batch.ts` derives it from `process.stdout.isTTY`, the same way
`run.ts` does for `resolveStreamOptions`):
- **TTY:** full table redrawn in place. The renderer tracks how many
  lines it last wrote (header + separator + N rows) and emits
  `\x1b[<N>A\x1b[0J` (cursor-up N, erase-to-end-of-screen) before each
  redraw. These are the same kinds of byte sequences `pretty.ts` uses
  inline today; the renderer writes its own — there is nothing to
  reuse-by-import. Redraw fires on every state change (turn tick,
  setDone, setErrored).
- **Non-TTY:** falls back to one append-only line per state change
  (`story-id-1: running turn 7 / 20`). No cursor tricks. The final frozen
  table is always printed at the end.

## Operational details

**Concurrency.** v1 is serial. `runOne` returns a promise; batch.ts awaits
one at a time. The serial-only assumption lives in batch.ts only — no other
module learns about it. A future `--concurrency N` is a localized change to
that loop.

**Error handling.** A run that throws is caught at the batch boundary;
that row goes to `errored`; the loop continues to the next card. There is
no `--fail-fast` in v1. SIGINT stops after the current run completes (or
aborts it via the existing `adapter.close()` in `runOne`'s `finally`) and
prints the frozen table.

A card whose path is missing or whose body fails `parseStoryCard` is
caught in `batch.ts` *before* `runOne` is called. The row is marked
`errored before start`; `cardId` falls back to the filename stem (no
parsed body to read `card.id` from); no per-run directory is created
because no `runOne` ran. The batch loop continues.

**Stdout-purity contract in batch mode.** The TTY redraw model assumes
nothing else writes to stdout while a run is in flight — any unexpected
write would shift the cursor and the next redraw would erase the wrong
N lines. `runAgent` and the adapters do not write to stdout today
(everything goes through `EvidenceLogger`). Batch mode treats this as a
contract: **`runOne` and anything it calls must not write to stdout.**
Stderr is unaffected. The single-card command's
`console.error("runId: ${runId}")` (today at `run.ts:139`) lives in the
single-card `run()` wrapper, *not* inside `runOne`, so it does not fire
in batch mode.

**Output mode interaction.**
- `--format jsonl`: the per-card observer that `batch.ts` registers writes
  `JSON.stringify({ runId, ...event }) + "\n"` to stdout for every event.
  No table, no `BatchTableRenderer`. The injection happens in the observer
  layer (`batch.ts`), not inside `JsonlRenderer` — `JsonlRenderer` is a
  dumb passthrough that doesn't know its logger's runId.
- `--silent`: suppresses the table and the per-event stream; prints only
  the final summary on stderr. Stdout is empty.
- Default (TTY, no `--silent`, no `--format jsonl`): the live status
  table.

**Exit code.** `0` iff every run finished with `status === "pass"`. `1`
otherwise. Splitting fail / investigate / errored into distinct codes is
deferred until a CI workflow asks for it.

**Final summary.** Always printed (on stdout in pretty/jsonl modes; on
stderr in `--silent`):

```
batch: 8 pass · 1 fail · 1 investigate · 0 errored
results: <.gauntlet>/results/
```

**Per-card snapshotting.** Each card still goes through
`snapshotRunInputs` at the start of its run, exactly as today. Each run
gets its own frozen `inputs/` view.

**Adapter handling.** Each card constructs a fresh adapter inside
`runOne`, exactly as today. Web-adapter Chrome profile names already
include `runId`, so serial web runs in a batch never see each other's
profile state. (When concurrency lands, this is also why parallel web
runs will work in principle — modulo Chrome RAM.)

## Testing

- **Unit:** `BatchTableRenderer` against scripted event sequences. Same
  pattern as the existing `PrettyRenderer` tests in `test/cli/stream/`.
  Cover: queued → running → done; running → errored; final frozen frame;
  non-TTY append mode; redraw width clamped to `$COLUMNS`.
- **Refactor guard:** the `runOne` extraction is a pure refactor. Existing
  `gauntlet run` tests must continue to pass without modification.
- **Integration:** `gauntlet batch a.md b.md` against the `cli` adapter
  with a stub target. Assert exit code, final table content, and that each
  card produced its own `<.gauntlet>/results/<runId>/` evidence directory.
- **Exit code matrix:** all-pass → 0; one fail → 1; one investigate → 1;
  one errored mid-run → 1; one card path missing / unparseable
  (errored-before-start) → 1.

## Migration / compatibility

None. `gauntlet batch` is new. `gauntlet run` is unchanged in behavior — it
uses the extracted `runOne`, but its CLI surface, output, and on-disk
evidence are identical to today.
