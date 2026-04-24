# CLI streaming transcript — design

**Status:** drafted, awaiting review.
**Author:** Anansi (Bob b872e219/Opus 4.7)
**Related:** `src/cli/run.ts`, `src/cli/args.ts`, `src/evidence/logger.ts`, `src/api/routes/run.ts`, `src/api/ws-handlers.ts`, `ui/src/components/transcript/`

## Problem

`gauntlet run <scenario> --target <url>` runs silently. The agent may take
tens of seconds per turn and a full run can last minutes. The user sees
nothing until the run finishes, at which point `src/cli/run.ts:115` prints
the full `result.json` to stdout and `runId: ...` to stderr.

The same run, started through `gauntlet serve` and the web UI, streams a
rich transcript over WebSocket — turn headers, thinking, tool calls with
timings, screenshots, errors — rendered by the React components in
`ui/src/components/transcript/`. The event channel feeding that UI
(`EvidenceLogger.addEventObserver` in `src/evidence/logger.ts:121`)
exists and is already wired to the WS broadcaster at
`src/api/routes/run.ts:236`. The CLI path bypasses it.

## Goal

Make the CLI a first-class way to watch a run live. Humans running it
interactively see a readable, colored transcript as events happen. Scripts
piping the output get structured JSONL. Neither case breaks the other.

## Decisions (summary)

- **Streaming is the default.** `--silent` opts out.
- **Format is TTY-aware.** Pretty on a terminal, JSONL when piped.
  `--format pretty|jsonl` overrides.
- **One opinionated pretty format.** Compact, subtle color, right-aligned
  timings. No theme config.
- **No `--verbose` flag.** Default is verbose-ish; anything fuller is
  available by reading `run.jsonl` on disk.
- **Long tool args truncated** at 200 chars with `… (+nnn more)`; text
  soft-wraps at `$COLUMNS` (fallback 100).
- **TUI captures show as a path reference** — never rendered inline.
- **Final result JSON is removed from stdout** in streaming mode;
  `result.json` on disk is unchanged and remains the machine-readable
  record.

## CLI surface

```
gauntlet run <scenario.md> --target <url> [flags]

  --silent              Suppress the streaming transcript entirely.
                        Stdout is empty; runId still printed to stderr.
  --format pretty|jsonl Override stream format. Default: auto —
                        pretty when stdout is a TTY, jsonl when piped.
  --no-color            Disable ANSI color. Also respected: NO_COLOR
                        environment variable (https://no-color.org).
```

No new environment variables. The auto-detection rule is: pretty iff
stdout is a TTY; color iff stdout is a TTY **and** neither `NO_COLOR` is
set nor `--no-color` was passed. `--format jsonl` forces JSONL regardless
of TTY; `--silent` takes precedence over both.

Existing flags (`--out`, `--adapter`, `--model`, `--chrome`, `--turns`,
`--viewport`, `--save-screencast`, `--project-dir`) are unchanged.

## Architecture

### Event flow

```
runAgent → EvidenceLogger.writeEvent → run.jsonl  (source of truth)
                        │
                        ├─► ActionObserver (existing, unchanged)
                        │
                        └─► EventObserver ─┬─► WS broadcaster (existing)
                                           │
                                           └─► StreamRenderer  (new)
                                                 ├─ PrettyRenderer
                                                 └─ JsonlRenderer
```

The CLI consumer mirrors the HTTP route at `src/api/routes/run.ts:234-239`:
attach an `EventObserver` in `src/cli/run.ts` immediately after
`new EvidenceLogger(outDir)` and before `runAgent`, guarded by the
`silent` flag. The renderer receives the same structured entries the
WebSocket does, so `run.jsonl`, the web transcript, and the CLI stream
are three views of one stream.

Renderer errors are isolated the way WS callbacks already are inside
`EvidenceLogger.notifyEventObservers` (`src/evidence/logger.ts:127-130`).
A buggy renderer cannot crash the run or corrupt `run.jsonl`.

### File layout

```
src/cli/stream/
  renderer.ts            # interface + shared types
  pretty.ts              # PrettyRenderer
  jsonl.ts               # JsonlRenderer
  format.ts              # tty/NO_COLOR/--format/--silent resolution
  colors.ts              # ANSI palette + NO_COLOR-aware wrap(fn)
  wrap.ts                # soft-wrap + truncate-at-200

test/cli/stream/
  pretty.test.ts         # golden-file tests
  jsonl.test.ts
  format.test.ts         # tty/pipe/flag/env matrix
  wrap.test.ts
```

One interface (`handle(event)` + `close()`). `format.ts` is the only
place that touches `process.stdout.isTTY` or reads env vars; everything
downstream takes resolved `{ silent, format, color, columns }`. `wrap.ts`
and `colors.ts` are pure utilities.

## Pretty format

The format mirrors the visual discipline of the web transcript compacted
for a terminal. Rendering rules, per event type:

- **`run_start`** — seven-line configured-values block with a dim rule
  above and below:
  ```
  ──────────────────────────────────────────────────────
    runId     r-8f21
    card      login-flow.md
    target    https://example.com
    model     claude-sonnet-4-6
    adapter   web · viewport 1440×900
    max turns 50
    evidence  .gauntlet/results/r-8f21/
  ──────────────────────────────────────────────────────
  ```
  `viewport` only shown for the web adapter.

- **`system_prompt`** — not rendered. (Available in `run.jsonl`.)

- **`user_message`** — not rendered as a standalone section; folded into
  the following turn.

- **`llm_request`** — nothing printed directly. While this is the last
  event seen on a TTY, a spinner line is shown in place:
  `⋯ waiting for model · 00:12`. Updated once per second, cleared on the
  next event. Off when stdout is not a TTY or under `--format jsonl`.

- **`llm_response`** — opens the turn header and renders content:
  ```
  ▎ Turn N · claude-sonnet-4-6 · turn N / max

    ~ thinking
      <text, soft-wrapped>

    = assistant
      <text, soft-wrapped>
  ```
  Thinking is suppressed when absent. Assistant text is always rendered,
  even if empty (then just the header).

- **`tool_call`** — a single `▸` line:
  ```
    ▸ click         { selector: ".login-btn" }             ⋯
  ```
  Name bold, args dim single-line JSON. Args truncated at 200 chars
  with `… (+<bytes> more)`. Timing slot is a dim ellipsis pending the
  matching `tool_result`.

- **`tool_result`** — replaces the pending ellipsis with timing:
  - Success: `✓ 420ms` (green).
  - Success with `image` / `artifact` / `capturePath`: adds a dim
    indented second line `→ screenshots/001.png`.
  - Failure: `✗ 1180ms` (red) followed by an indented error block:
    ```
      ╵ error  element not found: waited 1s for ".nonexistent"
      ╵ hint   closest match: ".login-button"
    ```
    The `hint` line is emitted only when the tool-result params carry
    adapter diagnostics (already plumbed via `selectorDiagnostics`).

- **`event`** — a dim single line `· <name> key=val key=val`. Rare —
  meta entries like `tool_result_text_oversize`.

- **`run_end`** — a terminal summary panel. Green rule on pass, red on
  any non-pass status:
  ```
  ─── Run complete ──────────────────────────────── ✓ pass
    runId     r-8f21
    duration  47.3s
    turns     3 / 50
    usage     in 12.4k  out 1.2k  cache 38.1k
    evidence  .gauntlet/results/r-8f21/
  ```
  Duration format: seconds with one decimal when < 60s, else `Mm SS.Ss`
  (e.g. `5m 12.3s`).

### Error paths

Three failure modes, all handled:

- **Tool call fails** — already modelled: the adapter throws, logger
  writes a `tool_result` with `error: true`. Renderer shows ✗, the error
  text, and the hint line when diagnostics are present. The run
  continues per the normal agent loop.
- **LLM API / fatal adapter error** — bubbles out of `runAgent`. The
  CLI wrapper catches, writes a synthetic entry through the logger
  (`logger.logEvent("run_error", { message, stack })`), closes the
  renderer, then re-throws so the existing non-zero exit path runs.
  Renderer recognises `run_error` and prints a red summary block in
  place of the normal `run_end` panel:
  ```
  ─── Run failed ──────────────────────────────────── ✗ error
    runId     r-8f21
    turn      3 / 50
    error     anthropic: rate_limit_error (40s remaining)
    evidence  .gauntlet/results/r-8f21/
  ```
- **Renderer throws** — isolated inside the observer; does not affect
  `run.jsonl` or the WS broadcaster.

### JSONL format

`JsonlRenderer` writes one JSON object per line to stdout, exactly the
entry written to `run.jsonl` (same shape, same field names, same
`eventId`/`parentEventId`). Consumers can `gauntlet run ... | jq` with
no translation layer. No pretty-printing, no color, no spinner.

The on-disk `run.jsonl` remains the authoritative artifact; the JSONL
stream is a convenience — a live tap on the same bytes.

### `--silent` mode

- Stdout: nothing.
- Stderr: one `runId: <id>` line printed at run completion (same
  placement as today's non-streaming path at `src/cli/run.ts:116`), plus
  whatever the existing fatal-error path writes. Nothing during the run.
- Disk: `result.json`, `run.jsonl`, screenshots, captures — all
  unchanged. Scripts that want the result read `result.json` from
  `.gauntlet/results/<runId>/` using the runId from stderr.

This is the behaviour that replaces today's stdout JSON dump. Anything
that previously parsed `gauntlet run` stdout needs to change to either
(a) read `result.json`, or (b) pass `--format jsonl` and parse the
event stream.

## Non-goals

- **`gauntlet attach <runId>`** — streaming a *running* run from a
  second shell. This design doesn't preclude it (a future command
  could tail `run.jsonl` and feed the same renderers), but no code
  for it now.
- **Inline screenshot / TUI-capture rendering.** Path reference only.
- **Streaming in `gauntlet fanout` / `gauntlet serve`.** Different
  surfaces. Serve already streams via WebSocket.
- **Configurable pretty format.** One opinionated default. `--silent`
  or `--format jsonl` if it doesn't suit.
- **Breaking-change migration shim for the old stdout JSON.** The
  change is intentional; the replacement is `result.json`.

## Testing

- **Golden-file tests per renderer.** Checked-in JSONL event fixtures
  feed each renderer; output is diffed against a checked-in `.txt`
  expected file. Three fixtures: happy-path run, failing tool call,
  fatal LLM error.
- **Format resolution matrix.** Table test covering
  `(isTTY, NO_COLOR, --format, --silent, --no-color)` inputs against
  resolved `{ silent, format, color }`.
- **Wrap / truncate.** Pure-function boundary tests at the 200-char
  cutoff and at the wrap column.
- **No Anthropic / OpenAI calls.** The renderer is tested against
  synthetic event streams; agent and model calls are out of scope
  for these tests.

## Open questions

None at design time.
