# Spec — TUI captures as first-class evidence

## Problem

TUI runs produce `read_screen` outputs that are currently inlined into `run.jsonl` as long ANSI-annotated text blobs. Two problems:

1. **No UI visibility today.** The Web UI has no renderer for TUI output; users can read the raw jsonl or nothing.
2. **jsonl bloat.** A 50-turn run with ~5KB of ANSI per capture is 250KB of text in a log file meant to be lean.
3. **Unicode correctness.** A naive `<pre>` + ANSI-to-HTML approach misrenders CJK and emoji because browser font widths don't always match what tmux counted as 2 columns.

## Shape of the change

Treat TUI screen captures as **first-class evidence**, mirroring how web treats screenshots — written to files on disk, referenced from the run log, rendered by a dedicated viewer in the Web UI. Parse the ANSI on the server into a structured cell grid so the UI renders a layout-correct 2D grid instead of guessing cell widths.

## On disk

Each capture becomes two files under the run's evidence directory:

```
captures/
  000.ansi     # raw capture-pane -e output, ground truth
  000.json     # parsed cell grid (see CaptureParser below)
  001.ansi
  001.json
  ...
```

Numbering is zero-padded, sequential in capture order. Both the raw and parsed forms are kept: the raw is the ground truth and cheap; the parsed form is what the UI consumes, cached so the UI doesn't re-parse on every render.

## Evidence schema

Extend `VetResult.evidence` (in `src/types.ts`) with:

```ts
evidence: {
  screenshots: string[];    // existing
  captures?: string[];      // new — paths of *.ansi files, parsed twin inferred
  log: string;
  ...
}
```

A run with no TUI captures omits the field entirely.

## Tool result shape in run.jsonl

The `read_screen` tool_result event keeps its existing shape but its `text` field is the capture path, not the inline payload:

```json
{"type":"tool_result","name":"read_screen","text":"captures/003.ansi","...": "..."}
```

Consumers that need the content (UI, grep tools, replay) fetch the file. This is what keeps jsonl small.

## CaptureParser interface

A parser-neutral seam that takes raw ANSI bytes and returns a structured grid:

```ts
// src/adapters/tui/capture-parser.ts
export interface CaptureParser {
  parse(ansi: string, cols: number, rows: number): Capture;
}

export interface Capture {
  cols: number;     // e.g. 120
  rows: number;     // e.g. 40
  cells: Cell[][];  // [row][col]; wide chars occupy one cell and set width=2
}

export interface Cell {
  ch: string;       // UTF-8 codepoint (or empty string for the 2nd half of a wide char)
  fg?: string;      // ANSI color name or hex
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  width: 1 | 2;     // East Asian Width
}
```

### Implementations

**Initial: `XtermCaptureParser`.** Backed by `@xterm/headless`. Feed the ANSI into a headless `Terminal`, walk `terminal.buffer.active` to emit the Cell grid. Handles Unicode width correctly out of the box.

**Later: `GhosttyCaptureParser`.** When ts-libghostty lands, second implementation behind the same interface. Both stay in-tree so captures can be parsed by each and Cell grids compared (differential testing).

### Selection

Parser choice is app-level config, not per-run. Start with xterm by default. Add a switch when ghostty is ready.

## Adapter wiring

`TUIAdapter.readScreen()` changes behavior for the tool pipeline — but not the internal API:

1. Capture ANSI via `tmux capture-pane -e` (unchanged).
2. Get the next capture index for this run (maintained on the adapter, or via the logger).
3. Write the raw ANSI to `captures/NNN.ansi`.
4. Parse via the configured `CaptureParser`, write the JSON to `captures/NNN.json`.
5. Return the relative path string — that's what lands in the tool_result.

The adapter's `readScreen()` for *internal* use (e.g. e2e tests asserting against the text) keeps its current signature returning a string; the capture-as-evidence path wraps it.

## Web UI

### Transcript view

For each `read_screen` tool_result in a run's transcript:

- Render the parsed capture as a **CSS grid** with explicit column count and row count.
- Each cell is its own DOM node, sized uniformly. Wide chars get `grid-column: span 2`.
- ANSI colors translated to CSS. Bold/italic/underline as text styles.
- Monospace font, but the grid itself enforces alignment so font-width lies don't matter.
- Fixed size container (120ch × 40em-ish); collapsible; default-collapsed past the first few lines of non-blank content.

### Live streaming

Reuse the existing `RunBroadcaster`. When a capture is written, emit a WS event `{type: "tui_capture", runId, path, index}`. Web UI appends to the transcript in real time. Matches how screencast/screenshot streaming already works — no new infrastructure.

## Out of scope (v1)

- **Diff between captures.** Highlighting what changed turn-to-turn is nicer than raw repetition but real work. Later pass.
- **Scrollback reconstruction.** The capture is the visible pane only; tmux holds scrollback but we don't ask for it.
- **Mouse events.** Captures don't track them; irrelevant anyway.
- **Capture scrubbing / timeline UI.** Inline sequential rendering is enough.
- **Re-parsing on parser upgrade.** If the parser changes, old `.json` files stay; `.ansi` is ground truth and can be re-parsed on demand if needed.

## Differential testing (when ghostty lands)

Once both parsers exist, CI test: for each sample `.ansi` capture in a fixture corpus, parse with both, assert matching Cell grids. Divergence is a bug in one of the parsers — correctness oracle for free.

A small corpus lives under `test/fixtures/tui/captures/` and grows as real-world TUIs expose interesting edge cases (emoji, CJK, reverse video, 256-color, truecolor).

## Estimate

~2 days of contiguous work for a Bob. Breakdown:
- Capture file format + adapter wiring: 0.5d
- Evidence schema extension + VetResult plumbing: 0.25d
- CaptureParser interface + xterm implementation: 0.5d
- Web UI grid renderer: 0.5d
- WS broadcast wiring: 0.25d

The parser-neutral seam is load-bearing: it means when ghostty arrives, the swap is one config line and one new file. Everything else stays.
