# CLI multi-story batch — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [docs/superpowers/specs/2026-04-27-cli-multi-story-batch-design.md](../specs/2026-04-27-cli-multi-story-batch-design.md)

**Goal:** Add `gauntlet batch <story.md> [more.md ...]` — runs N cards serially with one live status table on stdout, drops `--out`, keeps `--format jsonl` and `--silent` with batch-aware semantics, exits 0 iff every run is `pass`.

**Architecture:** Extract `runOne(card, opts)` from `src/cli/run.ts` into `src/cli/run-one.ts` with a single `onLogger` seam. Single-card `run()` keeps using `attachRenderer` via that seam; new `src/cli/batch.ts` orchestrator drives a per-card observer that updates a new `BatchTableRenderer` (state-push interface, *not* a `StreamRenderer`). Per-card evidence on disk is unchanged.

**Tech Stack:** TypeScript, Bun, `bun:test`, no new dependencies.

---

## File structure

**New files:**
- `src/cli/run-one.ts` — `runOne(card, opts) → Promise<RunSummary>` extracted from `run.ts`. Owns the `EvidenceLogger`, exposes only an `onLogger` hook.
- `src/cli/batch.ts` — `batch(opts) → Promise<BatchExitCode>`. Serial loop, parse-failure handling, per-card observer construction.
- `src/cli/stream/batch-table.ts` — `BatchTableRenderer` (state-push interface). TTY redraw mode + non-TTY append mode.
- `test/cli/run-one.test.ts` — covers the `onLogger` semantics and the single-card behavior preservation.
- `test/cli/batch.test.ts` — covers the orchestrator with a stubbed `runOne`.
- `test/cli/stream/batch-table.test.ts` — covers the renderer state machine and rendering output (both modes).

**Modified files:**
- `src/cli/run.ts` — becomes a thin wrapper that builds `streamOpts`, calls `runOne(card, { ..., onLogger: (logger) => attachRenderer(logger, streamOpts, sink) })`, then keeps the silent-branch `console.error("runId: ...")`. No behavior change.
- `src/cli/args.ts` — add `BatchArgs`, `BATCH_ALLOWED`, `parseBatchArgs`, `case "batch":` in `parseArgs`, add to `usage()`.
- `src/index.ts` — add `case "batch":` to `main()`.
- `test/cli/args.test.ts` — add tests for the `batch` command parser.

---

## Tasks

### Task 1: Extract `runOne` from `run.ts` into `src/cli/run-one.ts`

**Files:**
- Create: `src/cli/run-one.ts`
- Modify: `src/cli/run.ts` (becomes thin wrapper)
- Create: `test/cli/run-one.test.ts`

**Goal:** Pure refactor. After this task, `gauntlet run` behaves identically and all existing tests pass. The new seam is `onLogger?: (logger: EvidenceLogger) => () => void`.

- [ ] **Step 1: Read the current `run.ts`** to understand exactly what moves.

Run: `wc -l /Users/mw/Code/prime/gauntlet/src/cli/run.ts` — should be ~153 lines.
Mentally bracket what becomes `runOne`: everything from `parseStoryCard(content)` through the `try { ... runAgent ... } finally { detachStream(); await adapter.close(); }` block, but *excluding* `streamOpts`/`detachStream`/`attachRenderer` wiring and the silent-branch `console.error`.

- [ ] **Step 2: Write a failing test for `runOne`'s `onLogger` hook**

Create `test/cli/run-one.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { runOne } from "../../src/cli/run-one";

describe("runOne", () => {
  test("calls onLogger with the constructed EvidenceLogger and invokes its detach in finally", async () => {
    const calls: string[] = [];
    let detachCalled = 0;

    // We don't actually run an agent here — we throw from inside onLogger
    // to short-circuit, then verify both the call and the detach happened.
    await expect(
      runOne(
        // Minimal options: the test harness has to provide enough for runOne
        // to reach the onLogger call. We pass a non-existent card path so
        // parseStoryCard/snapshotRunInputs never run.
        // → We parameterize by mocking via a separate harness; see Step 4.
        {} as any,
      ),
    ).rejects.toBeDefined();

    // Real assertion: onLogger was invoked, detach was invoked
    expect(calls).toContain("onLogger");
    expect(detachCalled).toBe(1);
  });
});
```

Run: `bun test test/cli/run-one.test.ts`
Expected: FAIL — module `../../src/cli/run-one` does not exist.

- [ ] **Step 3: Create `src/cli/run-one.ts` by lifting from `run.ts`**

Create `src/cli/run-one.ts` with this content (lifted verbatim from `run.ts` lines 35–152, with the renderer attachment replaced by the `onLogger` seam):

```ts
import { readFileSync } from "fs";
import { join } from "path";
import { parseStoryCard } from "../format/story-card";
import { EvidenceLogger } from "../evidence/logger";
import { writeResultFiles } from "../evidence/writer";
import { runAgent } from "../agent/agent";
import { createClient, resolveProvider } from "../models/resolve";
import { CLIAdapter } from "../adapters/cli/adapter";
import { snapshotViewport } from "../adapters/adapter";
import { renderContextTree } from "../context/tree";
import { makeRunId } from "../util/id";
import { gauntletPath } from "../paths";
import { snapshotRunInputs } from "../runs/snapshot";
import type { AppConfig, Viewport } from "../config";
import type { RunConfigSnapshot, VetResult } from "../types";

function viewportString(v: Viewport | undefined): string | undefined {
  return v ? `${v.width}x${v.height}` : undefined;
}

export interface RunOneOptions {
  scenarioPath: string;
  target: string;
  outDir?: string;
  adapterType: "web" | "cli" | "tui";
  config: AppConfig;
  /** Invoked once with the freshly constructed EvidenceLogger, before
   * `runAgent` starts. Returns a detach function that runOne calls in its
   * `finally`. The single-card command uses this to attach the streaming
   * renderer; batch.ts uses it to subscribe its per-card observer. */
  onLogger?: (logger: EvidenceLogger) => () => void;
}

export interface RunOneSummary {
  runId: string;
  outDir: string;
  result: VetResult;
}

export async function runOne(opts: RunOneOptions): Promise<RunOneSummary> {
  const { scenarioPath, target, adapterType, config } = opts;

  const content = readFileSync(scenarioPath, "utf-8");
  const card = parseStoryCard(content);
  const runId = makeRunId(card.id);
  const outDir = opts.outDir ?? gauntletPath(config.projectRoot, "results", runId);
  snapshotRunInputs({
    runDir: outDir,
    storyPath: scenarioPath,
    contextRoot: gauntletPath(config.projectRoot, "context"),
  });
  const logger = new EvidenceLogger(outDir);
  const detach = opts.onLogger?.(logger) ?? (() => {});

  const client = createClient(config.models.agent);
  const contextRoot = join(outDir, "inputs", "context");
  const contextTree = renderContextTree(contextRoot);

  let adapter;
  switch (adapterType) {
    case "cli":
      adapter = new CLIAdapter({ contextRoot });
      await adapter.start(target);
      break;
    case "tui": {
      const { TUIAdapter } = await import("../adapters/tui/adapter");
      adapter = new TUIAdapter({ contextRoot });
      await adapter.start(target);
      break;
    }
    case "web": {
      const { WebAdapter } = await import("../adapters/web/adapter");
      const chromeOpt = config.sources.defaultChrome === "default"
        ? undefined
        : config.defaultChrome;
      const chromeProfileName = `gauntlet-run-${runId}`;
      adapter = new WebAdapter({
        chrome: chromeOpt,
        contextRoot,
        logger,
        chromeProfileName,
        viewport: config.defaultViewport,
      });
      await adapter.start(target);
      break;
    }
  }

  const chromeOptForSnapshot = config.sources.defaultChrome === "default"
    ? undefined
    : config.defaultChrome;
  const runConfig: RunConfigSnapshot = {
    target,
    model: config.models.agent,
    adapter: adapterType,
    chrome: chromeOptForSnapshot ? `${chromeOptForSnapshot.host}:${chromeOptForSnapshot.port}` : undefined,
    turns: config.defaultTurns,
    viewport: snapshotViewport(adapter),
  };

  try {
    const result = await runAgent(card, adapter, client, logger, target, {
      contextTree,
      runId,
      maxTurns: config.defaultTurns,
      provider: resolveProvider(config.models.agent),
      model: config.models.agent,
      outDir,
      viewport: adapterType === "web" ? viewportString(snapshotViewport(adapter)) : undefined,
    });
    result.config = runConfig;
    writeResultFiles(outDir, result);
    return { runId, outDir, result };
  } catch (err) {
    logger.logEvent("run_error", {
      turn: -1,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  } finally {
    detach();
    await adapter.close();
  }
}
```

- [ ] **Step 4: Replace `src/cli/run.ts` with the thin wrapper**

Replace the full body of `src/cli/run.ts` with:

```ts
import { runOne } from "./run-one";
import { attachRenderer } from "./stream/attach";
import { resolveStreamOptions } from "./stream/format";
import type { AppConfig } from "../config";

export interface RunCommandOptions {
  scenarioPath: string;
  target: string;
  outDir?: string;
  adapterType: "web" | "cli" | "tui";
  config: AppConfig;
  silent: boolean;
  format: "pretty" | "jsonl" | undefined;
  noColor: boolean;
}

export async function run(opts: RunCommandOptions): Promise<void> {
  const streamOpts = resolveStreamOptions({
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env as Record<string, string | undefined>,
    silent: opts.silent,
    format: opts.format,
    noColor: opts.noColor,
    columns: process.stdout.columns ?? 100,
  });
  const sink = { write: (s: string) => process.stdout.write(s) };

  const { runId } = await runOne({
    scenarioPath: opts.scenarioPath,
    target: opts.target,
    outDir: opts.outDir,
    adapterType: opts.adapterType,
    config: opts.config,
    onLogger: (logger) => attachRenderer(logger, streamOpts, sink),
  });

  if (streamOpts.silent) {
    console.error(`runId: ${runId}`);
  }
  // Streaming mode: run_end panel already printed the runId via the renderer.
}
```

- [ ] **Step 5: Rewrite the run-one test to use a real fixture**

Replace `test/cli/run-one.test.ts` with a focused test that doesn't try to drive a full `runAgent`. Test only the `onLogger` plumbing by passing a card that fails at `parseStoryCard`, asserting the throw propagates and `onLogger` was *not* called (because the logger isn't constructed until after parse):

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runOne } from "../../src/cli/run-one";
import type { AppConfig } from "../../src/config";

function makeConfig(projectRoot: string): AppConfig {
  // Minimal AppConfig for runOne. createClient is called for "claude-sonnet-4-6"
  // but we never reach it because we throw earlier.
  return {
    projectRoot,
    port: 4400,
    defaultChrome: { host: "127.0.0.1", port: 9222 },
    defaultTurns: 5,
    defaultViewport: { width: 1440, height: 900 },
    saveScreencast: false,
    models: { agent: "claude-sonnet-4-6", fanout: undefined },
    sources: { defaultChrome: "default" },
  } as any;
}

describe("runOne", () => {
  test("propagates parseStoryCard errors and never calls onLogger when parse fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-runone-"));
    const badCard = join(dir, "bad.md");
    writeFileSync(badCard, "this is not a valid story card");

    let onLoggerCalls = 0;
    await expect(
      runOne({
        scenarioPath: badCard,
        target: "noop",
        adapterType: "cli",
        config: makeConfig(dir),
        onLogger: () => {
          onLoggerCalls += 1;
          return () => {};
        },
      }),
    ).rejects.toBeDefined();

    expect(onLoggerCalls).toBe(0);
  });
});
```

- [ ] **Step 6: Run the full test suite**

Run: `bun run typecheck && bun test`
Expected: All tests pass — including the new `run-one.test.ts` and every existing `cli/`/`api/`/`e2e/` test, since this is a pure refactor.

- [ ] **Step 7: Commit**

```bash
git add src/cli/run-one.ts src/cli/run.ts test/cli/run-one.test.ts
git commit -m "refactor(cli): extract runOne from run.ts with onLogger seam"
```

---

### Task 2: `BatchTableRenderer` — non-TTY (append) mode

**Files:**
- Create: `src/cli/stream/batch-table.ts`
- Create: `test/cli/stream/batch-table.test.ts`

**Goal:** Renderer state machine + append-mode rendering. No TTY redraw yet.

- [ ] **Step 1: Write the failing test for the state machine and append output**

Create `test/cli/stream/batch-table.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { BatchTableRenderer } from "../../../src/cli/stream/batch-table";

function collect(): { out: string; write: (s: string) => void } {
  const obj = { out: "", write(s: string) { obj.out += s; } };
  return obj;
}

describe("BatchTableRenderer (append mode)", () => {
  test("emits one append line per state change", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, { isTTY: false, color: false, columns: 100 });
    r.setQueued("story-a");
    r.setQueued("story-b");
    r.setRunning("story-a", "run-a-1", 20);
    r.onTurn("story-a", 7);
    r.setDone("story-a", "investigate", 8);
    r.setRunning("story-b", "run-b-1", 20);
    r.setErrored("story-b", 3, "boom");
    r.finalize();

    const lines = sink.out.split("\n").filter(Boolean);
    expect(lines).toContain("story-a: queued");
    expect(lines).toContain("story-b: queued");
    expect(lines).toContain("story-a: running turn 0 / 20");
    expect(lines).toContain("story-a: running turn 7 / 20");
    expect(lines).toContain("story-a: done (investigate) on turn 8");
    expect(lines).toContain("story-b: errored on turn 3");
    // Final summary line — present in every mode that uses the table.
    expect(sink.out).toContain("batch: 0 pass · 0 fail · 1 investigate · 1 errored");
  });

  test("setErrored before start renders without a turn number", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, { isTTY: false, color: false, columns: 100 });
    r.setQueued("story-x");
    r.setErrored("story-x", null, "card path missing");
    r.finalize();
    expect(sink.out).toContain("story-x: errored before start");
  });
});
```

Run: `bun test test/cli/stream/batch-table.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 2: Implement `BatchTableRenderer` for append mode only**

Create `src/cli/stream/batch-table.ts`:

```ts
import type { WriteSink } from "./jsonl";

export type VetStatus = "pass" | "fail" | "investigate";

interface CardRow {
  cardId: string;
  runId: string | null;
  state: "queued" | "running" | "done" | "errored";
  turn: number;
  maxTurns: number;
  finalStatus: VetStatus | null;
  errorTurn: number | null;
  errorMessage: string | null;
}

export interface BatchTableOptions {
  isTTY: boolean;
  color: boolean;
  columns: number;
}

export class BatchTableRenderer {
  private rows = new Map<string, CardRow>();
  private order: string[] = [];

  constructor(private sink: WriteSink, private opts: BatchTableOptions) {}

  setQueued(cardId: string): void {
    if (!this.rows.has(cardId)) this.order.push(cardId);
    this.rows.set(cardId, {
      cardId,
      runId: null,
      state: "queued",
      turn: 0,
      maxTurns: 0,
      finalStatus: null,
      errorTurn: null,
      errorMessage: null,
    });
    this.emitAppendLine(`${cardId}: queued`);
  }

  setRunning(cardId: string, runId: string, maxTurns: number): void {
    const row = this.rows.get(cardId);
    if (!row) return;
    row.runId = runId;
    row.state = "running";
    row.maxTurns = maxTurns;
    this.emitAppendLine(`${cardId}: running turn ${row.turn} / ${maxTurns}`);
  }

  onTurn(cardId: string, turn: number): void {
    const row = this.rows.get(cardId);
    if (!row || row.state !== "running") return;
    row.turn = turn;
    this.emitAppendLine(`${cardId}: running turn ${turn} / ${row.maxTurns}`);
  }

  setDone(cardId: string, finalStatus: VetStatus, turn: number): void {
    const row = this.rows.get(cardId);
    if (!row) return;
    row.state = "done";
    row.finalStatus = finalStatus;
    row.turn = turn;
    this.emitAppendLine(`${cardId}: done (${finalStatus}) on turn ${turn}`);
  }

  setErrored(cardId: string, turn: number | null, message: string): void {
    const row = this.rows.get(cardId);
    if (!row) return;
    // If the caller didn't pass a turn but the row was already running,
    // use the row's last-known turn. This way batch.ts can call
    // setErrored(cardId, null, msg) for any failure and the table picks
    // the right wording (`errored before start` vs `errored on turn N`).
    const wasRunning = row.state === "running";
    const effectiveTurn = turn ?? (wasRunning ? row.turn : null);
    row.state = "errored";
    row.errorTurn = effectiveTurn;
    row.errorMessage = message;
    if (effectiveTurn === null) this.emitAppendLine(`${cardId}: errored before start`);
    else this.emitAppendLine(`${cardId}: errored on turn ${effectiveTurn}`);
  }

  finalize(): void {
    let pass = 0, fail = 0, investigate = 0, errored = 0;
    for (const cardId of this.order) {
      const row = this.rows.get(cardId);
      if (!row) continue;
      if (row.state === "errored") errored++;
      else if (row.finalStatus === "pass") pass++;
      else if (row.finalStatus === "fail") fail++;
      else if (row.finalStatus === "investigate") investigate++;
    }
    this.emitAppendLine(
      `batch: ${pass} pass · ${fail} fail · ${investigate} investigate · ${errored} errored`,
    );
  }

  private emitAppendLine(line: string): void {
    if (this.opts.isTTY) return; // TTY mode handled in Task 3
    this.sink.write(line + "\n");
  }
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `bun test test/cli/stream/batch-table.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/stream/batch-table.ts test/cli/stream/batch-table.test.ts
git commit -m "feat(cli): BatchTableRenderer — state machine + append mode"
```

---

### Task 3: `BatchTableRenderer` — TTY redraw mode

**Files:**
- Modify: `src/cli/stream/batch-table.ts`
- Modify: `test/cli/stream/batch-table.test.ts`

**Goal:** Add the in-place redraw using `\x1b[<N>A\x1b[0J` (cursor up N, erase to end of screen).

- [ ] **Step 1: Add a failing TTY test**

Append to `test/cli/stream/batch-table.test.ts`:

```ts
describe("BatchTableRenderer (TTY mode)", () => {
  test("renders the full table on each state change with a cursor-up + erase prefix on subsequent frames", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, { isTTY: true, color: false, columns: 80 });
    r.setQueued("story-a");
    r.setQueued("story-b");
    // Two frames so far. The second frame must be preceded by a cursor-up
    // sequence sized to the previous frame's line count.
    expect(sink.out).toContain("Gauntlet running in Batch Mode");
    expect(sink.out).toContain("story-a");
    expect(sink.out).toContain("story-b");
    expect(sink.out).toContain("(queued)");
    // Cursor-up + erase-to-end-of-screen sequence appears at least once.
    expect(sink.out).toMatch(/\x1b\[\d+A\x1b\[0J/);
  });

  test("running and done rows render with the right status text and result flag", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, { isTTY: true, color: false, columns: 100 });
    r.setQueued("story-a");
    r.setRunning("story-a", "run-1", 20);
    r.onTurn("story-a", 7);
    r.setDone("story-a", "investigate", 8);
    r.finalize();
    // The final frame must contain the completed status text and the
    // VetStatus result flag.
    expect(sink.out).toContain("Complete on turn 8 / 20");
    expect(sink.out).toContain("investigate");
  });
});
```

Run: `bun test test/cli/stream/batch-table.test.ts`
Expected: FAIL — TTY mode is currently a no-op (`if (this.opts.isTTY) return`).

- [ ] **Step 2: Implement `redrawTTY` and the row formatter**

Edit `src/cli/stream/batch-table.ts`. Replace the body of `emitAppendLine` and add the TTY helpers. The full updated class body:

```ts
  private linesLastWritten = 0;

  private emitAppendLine(line: string): void {
    if (this.opts.isTTY) {
      this.redrawTTY();
      return;
    }
    this.sink.write(line + "\n");
  }

  private redrawTTY(): void {
    const frame = this.renderFrame();
    if (this.linesLastWritten > 0) {
      // Cursor up N lines, erase from there to end of screen.
      this.sink.write(`\x1b[${this.linesLastWritten}A\x1b[0J`);
    }
    this.sink.write(frame);
    this.linesLastWritten = frame.split("\n").length - 1; // trailing \n doesn't add a line
  }

  private renderFrame(): string {
    const header = "Gauntlet running in Batch Mode";
    const rule = "==============================";
    const idWidth = Math.max(...this.order.map((c) => c.length), 1);
    const lines: string[] = [header, rule];
    for (const cardId of this.order) {
      const row = this.rows.get(cardId);
      if (!row) continue;
      lines.push(`  ${cardId.padEnd(idWidth)}  ${this.statusText(row)}`);
    }
    return lines.join("\n") + "\n";
  }

  private statusText(row: CardRow): string {
    switch (row.state) {
      case "queued":
        return "(queued)";
      case "running":
        return `Running turn ${row.turn} / ${row.maxTurns}`;
      case "done":
        return `Complete on turn ${row.turn} / ${row.maxTurns}    ${row.finalStatus}`;
      case "errored":
        if (row.errorTurn === null) return "Errored before start    error";
        return `Errored on turn ${row.errorTurn}    error`;
    }
  }
```

Also replace the `finalize` method so it triggers a final redraw before printing the summary in TTY mode:

```ts
  finalize(): void {
    if (this.opts.isTTY) this.redrawTTY();
    let pass = 0, fail = 0, investigate = 0, errored = 0;
    for (const cardId of this.order) {
      const row = this.rows.get(cardId);
      if (!row) continue;
      if (row.state === "errored") errored++;
      else if (row.finalStatus === "pass") pass++;
      else if (row.finalStatus === "fail") fail++;
      else if (row.finalStatus === "investigate") investigate++;
    }
    this.sink.write(
      `\nbatch: ${pass} pass · ${fail} fail · ${investigate} investigate · ${errored} errored\n`,
    );
  }
```

- [ ] **Step 3: Run the tests**

Run: `bun test test/cli/stream/batch-table.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 4: Commit**

```bash
git add src/cli/stream/batch-table.ts test/cli/stream/batch-table.test.ts
git commit -m "feat(cli): BatchTableRenderer — TTY in-place redraw"
```

---

### Task 4: `gauntlet batch` argument parsing

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `test/cli/args.test.ts`

**Goal:** New subcommand parses one-or-more positional card paths plus the per-card and output flags. Same flag set as `run` *minus* `--out`.

- [ ] **Step 1: Add failing tests in `test/cli/args.test.ts`**

Append to the `describe("parseArgs", ...)` block:

```ts
  test("parses batch with multiple positional cards", () => {
    const args = parseArgs([
      "bun", "index.ts", "batch", "a.md", "b.md",
      "--target", "http://localhost:3000",
    ]);
    expect(args.command).toBe("batch");
    if (args.command !== "batch") throw new Error("unreachable");
    expect(args.scenarioPaths).toEqual(["a.md", "b.md"]);
    expect(args.cli.target).toBe("http://localhost:3000");
    expect(args.silent).toBe(false);
    expect(args.format).toBeUndefined();
    expect(args.noColor).toBe(false);
  });

  test("batch rejects --out", () => {
    expect(() =>
      parseArgs(["bun", "index.ts", "batch", "a.md", "--target", "u", "--out", "/tmp"]),
    ).toThrow(/Unknown flag/);
  });

  test("batch requires at least one card", () => {
    expect(() =>
      parseArgs(["bun", "index.ts", "batch", "--target", "u"]),
    ).toThrow(/at least one/i);
  });

  test("batch requires --target", () => {
    expect(() => parseArgs(["bun", "index.ts", "batch", "a.md"])).toThrow(/--target/);
  });

  test("batch parses --silent and --format jsonl", () => {
    const args = parseArgs([
      "bun", "index.ts", "batch", "a.md", "--target", "u",
      "--silent", "--format", "jsonl",
    ]);
    if (args.command !== "batch") throw new Error("unreachable");
    expect(args.silent).toBe(true);
    expect(args.format).toBe("jsonl");
  });
```

Run: `bun test test/cli/args.test.ts`
Expected: FAIL — `parseArgs` doesn't know about `batch`.

- [ ] **Step 2: Wire `batch` into `args.ts`**

Edit `src/cli/args.ts`. Add the allowed-flags set near the top of the file (alongside `RUN_ALLOWED`):

```ts
const BATCH_ALLOWED = new Set([
  "target", "adapter", "model", "chrome", "project-dir",
  "turns", "viewport", "save-screencast",
  "silent", "format", "no-color",
]);
```

Add the `BatchArgs` interface near the other `*Args` interfaces:

```ts
export interface BatchArgs {
  command: "batch";
  scenarioPaths: string[];
  adapter: AdapterType;
  silent: boolean;
  format: "pretty" | "jsonl" | undefined;
  noColor: boolean;
  cli: CliArgsInput;
}
```

Update `ParsedArgs`:

```ts
export type ParsedArgs = RunArgs | BatchArgs | ValidateArgs | FanoutArgs | ServeArgs | ConfigArgs;
```

Add a `case "batch":` branch in `parseArgs`:

```ts
    case "batch":
      return parseBatchArgs(args.slice(1));
```

Add `parseBatchArgs` (mirrors `parseRunArgs`, but collects all positionals and forbids `--out`):

```ts
function parseBatchArgs(args: string[]): BatchArgs {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { i++; continue; }
    positionals.push(args[i]);
  }
  if (positionals.length === 0) {
    throw new Error("Missing card paths\n\nUsage: gauntlet batch <story.md> [more.md ...] --target <url>\n\nAt least one card path is required.");
  }

  const flags = parseFlags(args);
  rejectUnknownFlags(flags, BATCH_ALLOWED, "batch");
  if (!flags.target) {
    throw new Error("Missing required flag: --target <url>");
  }

  let adapter: AdapterType = "web";
  if (flags.adapter !== undefined) {
    if (!isAdapterType(flags.adapter)) {
      throw new Error(
        `Invalid --adapter value "${flags.adapter}": must be one of ${ADAPTER_TYPES.join(", ")}`,
      );
    }
    adapter = flags.adapter;
  }

  let format: "pretty" | "jsonl" | undefined;
  if (flags.format !== undefined) {
    if (flags.format !== "pretty" && flags.format !== "jsonl") {
      throw new Error(`Invalid --format value "${flags.format}": must be "pretty" or "jsonl"`);
    }
    format = flags.format;
  }

  return {
    command: "batch",
    scenarioPaths: positionals,
    adapter,
    silent: flags.silent === "true",
    format,
    noColor: flags["no-color"] === "true",
    cli: {
      projectRoot: flags["project-dir"],
      chrome: flags.chrome,
      target: flags.target,
      turns: parseIntFlag(flags.turns, "--turns"),
      viewport: flags.viewport,
      saveScreencast: parseBoolFlag(flags["save-screencast"], "--save-screencast"),
      models: parseModelFlagArray(flags.model),
    },
  };
}
```

Update the `usage()` string to add a `batch` block (place it directly after the `run` block):

```
  batch <story.md> [more.md ...]  Run multiple cards serially
    --target <url>       (required) Application under test
    --model agent=<name> Model for the agent
    --chrome host:port   Chrome debugging endpoint
    --adapter <type>     web | cli | tui (default: web)
    --turns <n>          Max agent turns per run
    --viewport WxH       Browser viewport
    --save-screencast    Persist screencast frames to disk
    --project-dir <dir>  Project root
    --silent             Suppress the table; only print final summary
    --format <mode>      pretty | jsonl (default: auto by TTY)
    --no-color           Disable ANSI color
```

- [ ] **Step 3: Run the tests**

Run: `bun test test/cli/args.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/args.ts test/cli/args.test.ts
git commit -m "feat(cli): parse 'gauntlet batch' subcommand"
```

---

### Task 5: `batch.ts` orchestrator — happy path with stubbed `runOne`

**Files:**
- Create: `src/cli/batch.ts`
- Create: `test/cli/batch.test.ts`

**Goal:** Serial loop. Per-card observer drives the table. Tests use a stubbed `runOne` so we don't need a real LLM.

- [ ] **Step 1: Write the failing test**

Create `test/cli/batch.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import type { EvidenceLogger, EventObserver } from "../../src/evidence/logger";
import { runBatch } from "../../src/cli/batch";
import type { AppConfig } from "../../src/config";

function fakeLogger(observer: EventObserver | null): EvidenceLogger {
  return {
    addEventObserver(fn: EventObserver) {
      // The orchestrator calls addEventObserver in onLogger; the stub
      // captures it here so the test driver can fire synthetic events.
      (observer as any) = fn;
      return () => {};
    },
    logEvent: () => {},
  } as any;
}

function makeConfig(): AppConfig {
  return {
    projectRoot: "/tmp/x",
    port: 4400,
    defaultChrome: { host: "127.0.0.1", port: 9222 },
    defaultTurns: 5,
    defaultViewport: { width: 1440, height: 900 },
    saveScreencast: false,
    models: { agent: "claude-sonnet-4-6", fanout: undefined },
    sources: { defaultChrome: "default" },
  } as any;
}

function collectSink() {
  const obj = { out: "", write(s: string) { obj.out += s; } };
  return obj;
}

describe("runBatch", () => {
  test("serial loop calls runOne for each card and produces a final summary", async () => {
    const sink = collectSink();
    const calls: string[] = [];

    const stubRunOne = async (opts: { scenarioPath: string; onLogger?: any }) => {
      calls.push(opts.scenarioPath);
      // Drive the observer with a minimal happy-path event sequence.
      let observer: EventObserver | null = null;
      const fakeLog: any = {
        addEventObserver(fn: EventObserver) { observer = fn; return () => {}; },
        logEvent: () => {},
      };
      const detach = opts.onLogger?.(fakeLog) ?? (() => {});
      observer?.({ type: "run_start", runId: `run-${opts.scenarioPath}`, cardId: opts.scenarioPath, maxTurns: 20 } as any);
      observer?.({ type: "llm_response", turn: 3, stopReason: "end_turn" } as any);
      observer?.({ type: "run_end", status: "pass", durationMs: 1000, usage: { turns: 4 } } as any);
      detach();
      return {
        runId: `run-${opts.scenarioPath}`,
        outDir: `/tmp/${opts.scenarioPath}`,
        result: { status: "pass" } as any,
      };
    };

    const exitCode = await runBatch(
      {
        scenarioPaths: ["a.md", "b.md"],
        target: "http://localhost",
        adapterType: "cli",
        config: makeConfig(),
        silent: false,
        format: undefined,
        noColor: true,
        sink,
        isTTY: false,
      },
      stubRunOne as any,
    );

    // The runOne stub is called with the scenarioPath as given; the table
    // displays each row keyed by `basename(path, extname(path))` — so the
    // table shows `a` / `b`, not `a.md` / `b.md`.
    expect(calls).toEqual(["a.md", "b.md"]);
    expect(exitCode).toBe(0);
    expect(sink.out).toContain("a: queued");
    expect(sink.out).toContain("b: queued");
    expect(sink.out).toContain("a: done (pass)");
    expect(sink.out).toContain("b: done (pass)");
    expect(sink.out).toContain("batch: 2 pass · 0 fail · 0 investigate · 0 errored");
  });
});
```

Run: `bun test test/cli/batch.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 2: Implement `src/cli/batch.ts`**

Create `src/cli/batch.ts`:

```ts
import { basename, extname } from "path";
import type { AppConfig } from "../config";
import type { EvidenceLogger, EventObserver } from "../evidence/logger";
import { runOne, type RunOneOptions, type RunOneSummary } from "./run-one";
import { BatchTableRenderer } from "./stream/batch-table";
import type { WriteSink } from "./stream/jsonl";

export interface BatchOptions {
  scenarioPaths: string[];
  target: string;
  adapterType: "web" | "cli" | "tui";
  config: AppConfig;
  silent: boolean;
  format: "pretty" | "jsonl" | undefined;
  noColor: boolean;
  sink: WriteSink;
  isTTY: boolean;
}

type RunOneFn = (opts: RunOneOptions) => Promise<RunOneSummary>;

function cardIdForPath(p: string): string {
  // v1: filename stem is the row identifier. Stable for queued rows
  // (no parse needed) and for parse-failure rows.
  return basename(p, extname(p));
}

export async function runBatch(
  opts: BatchOptions,
  runOneImpl: RunOneFn = runOne,
): Promise<number> {
  const cards = opts.scenarioPaths.map((p) => ({ path: p, cardId: cardIdForPath(p) }));
  const useTable = !opts.silent && opts.format !== "jsonl";
  const table = useTable
    ? new BatchTableRenderer(opts.sink, {
        isTTY: opts.isTTY,
        color: !opts.noColor && opts.isTTY,
        columns: 100,
      })
    : null;

  if (table) for (const c of cards) table.setQueued(c.cardId);

  let pass = 0, fail = 0, investigate = 0, errored = 0;

  for (const c of cards) {
    let currentRunId: string | null = null;

    const onLogger = (logger: EvidenceLogger) => {
      const observer: EventObserver = (ev) => {
        const t = ev.type as string;
        if (t === "run_start") {
          currentRunId = String((ev as any).runId);
          if (table) {
            table.setRunning(c.cardId, currentRunId, Number((ev as any).maxTurns ?? 0));
          }
        } else if (t === "llm_response") {
          if (table) table.onTurn(c.cardId, Number((ev as any).turn ?? 0));
        } else if (t === "run_end") {
          const status = String((ev as any).status ?? "fail") as "pass" | "fail" | "investigate";
          const turns = Number(((ev as any).usage?.turns) ?? 0);
          if (table) table.setDone(c.cardId, status, turns);
        }

        if (opts.format === "jsonl" && !opts.silent) {
          const enriched = { runId: currentRunId, ...ev };
          opts.sink.write(JSON.stringify(enriched) + "\n");
        }
      };
      return logger.addEventObserver(observer);
    };

    try {
      const summary = await runOneImpl({
        scenarioPath: c.path,
        target: opts.target,
        adapterType: opts.adapterType,
        config: opts.config,
        onLogger,
      });
      const s = summary.result.status;
      if (s === "pass") pass++;
      else if (s === "fail") fail++;
      else if (s === "investigate") investigate++;
      else errored++;
    } catch (err) {
      errored++;
      const msg = err instanceof Error ? err.message : String(err);
      if (table) table.setErrored(c.cardId, null, msg);
    }
  }

  if (table) {
    table.finalize();
  } else if (opts.silent) {
    console.error(
      `batch: ${pass} pass · ${fail} fail · ${investigate} investigate · ${errored} errored`,
    );
  }

  return (fail + investigate + errored) === 0 ? 0 : 1;
}
```

- [ ] **Step 3: Run the tests**

Run: `bun test test/cli/batch.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/batch.ts test/cli/batch.test.ts
git commit -m "feat(cli): batch orchestrator — serial happy path"
```

---

### Task 6: `batch.ts` — error and parse-failure handling, exit code matrix

**Files:**
- Modify: `test/cli/batch.test.ts` (add cases)

**Goal:** Cover the error rows: card path missing, runOne throws mid-run, mixed pass/fail/investigate. Verify exit code matrix.

- [ ] **Step 1: Add failing tests**

Append to `test/cli/batch.test.ts`:

```ts
describe("runBatch — error handling", () => {
  test("runOne throwing marks the row errored and the loop continues", async () => {
    const sink = collectSink();
    const calls: string[] = [];
    let i = 0;
    const stub: any = async (opts: any) => {
      calls.push(opts.scenarioPath);
      if (i++ === 0) throw new Error("boom");
      const observer = (await new Promise<EventObserver>((resolve) => {
        const fakeLog: any = { addEventObserver: (fn: EventObserver) => { resolve(fn); return () => {}; }, logEvent: () => {} };
        opts.onLogger?.(fakeLog);
      }));
      observer({ type: "run_start", runId: "r2", cardId: "b.md", maxTurns: 20 } as any);
      observer({ type: "run_end", status: "pass", usage: { turns: 1 } } as any);
      return { runId: "r2", outDir: "/tmp/b.md", result: { status: "pass" } };
    };

    const exitCode = await runBatch(
      {
        scenarioPaths: ["a.md", "b.md"],
        target: "x", adapterType: "cli", config: makeConfig(),
        silent: false, format: undefined, noColor: true,
        sink, isTTY: false,
      },
      stub,
    );

    expect(calls).toEqual(["a.md", "b.md"]);
    expect(exitCode).toBe(1);
    expect(sink.out).toContain("a: errored");
    expect(sink.out).toContain("b: done (pass)");
    expect(sink.out).toContain("batch: 1 pass · 0 fail · 0 investigate · 1 errored");
  });

  test("any non-pass result yields exit code 1", async () => {
    const sink = collectSink();
    const stub: any = async (opts: any) => {
      const observer = (await new Promise<EventObserver>((resolve) => {
        const fakeLog: any = { addEventObserver: (fn: EventObserver) => { resolve(fn); return () => {}; }, logEvent: () => {} };
        opts.onLogger?.(fakeLog);
      }));
      observer({ type: "run_start", runId: "r", cardId: opts.scenarioPath, maxTurns: 20 } as any);
      observer({ type: "run_end", status: "investigate", usage: { turns: 1 } } as any);
      return { runId: "r", outDir: "/tmp/x", result: { status: "investigate" } };
    };

    const exitCode = await runBatch(
      {
        scenarioPaths: ["a.md"],
        target: "x", adapterType: "cli", config: makeConfig(),
        silent: false, format: undefined, noColor: true,
        sink, isTTY: false,
      },
      stub,
    );
    expect(exitCode).toBe(1);
  });
});
```

Run: `bun test test/cli/batch.test.ts`
Expected: PASS — the existing implementation already handles these (Task 5's `try/catch` and `nonPass` accounting).

- [ ] **Step 2: Verify the parse-failure path**

The `runOne` extraction (Task 1) already throws when `parseStoryCard` fails. The `runBatch` `try/catch` already converts that to an `errored` row. No code change needed for Task 6 if Step 1 passes. If it doesn't, fix the implementation in `src/cli/batch.ts` rather than the test.

- [ ] **Step 3: Commit**

```bash
git add test/cli/batch.test.ts
git commit -m "test(cli): batch — error and exit-code matrix"
```

---

### Task 7: `batch.ts` — `--format jsonl` and `--silent` modes (tests only)

**Files:**
- Modify: `test/cli/batch.test.ts` (add cases)

**Goal:** Verify jsonl mode emits per-event lines with `runId` injected, and silent mode produces only the summary on stderr. The implementation is already in place from Task 5; this task is the test-coverage pass.

- [ ] **Step 1: Add the tests**

Append to `test/cli/batch.test.ts`:

```ts
describe("runBatch — output modes", () => {
  test("--format jsonl emits one event per line with runId injected", async () => {
    const sink = collectSink();
    const stub: any = async (opts: any) => {
      const observer = (await new Promise<EventObserver>((resolve) => {
        const fakeLog: any = { addEventObserver: (fn: EventObserver) => { resolve(fn); return () => {}; }, logEvent: () => {} };
        opts.onLogger?.(fakeLog);
      }));
      observer({ type: "run_start", runId: "RUN-1", cardId: "a", maxTurns: 20 } as any);
      observer({ type: "llm_response", turn: 1, stopReason: "end_turn" } as any);
      observer({ type: "run_end", status: "pass", usage: { turns: 1 } } as any);
      return { runId: "RUN-1", outDir: "/tmp/a", result: { status: "pass" } };
    };

    await runBatch(
      {
        scenarioPaths: ["a.md"],
        target: "x", adapterType: "cli", config: makeConfig(),
        silent: false, format: "jsonl", noColor: true,
        sink, isTTY: false,
      },
      stub,
    );

    const lines = sink.out.split("\n").filter(Boolean);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.runId).toBe("RUN-1");
    }
    // No table output: no "queued" lines, no batch-summary line.
    expect(sink.out).not.toContain("queued");
    expect(sink.out).not.toContain("batch:");
  });

  test("--silent suppresses everything except the final summary on stderr", async () => {
    // We capture both stdout (via sink) and stderr by spying on console.error.
    const sink = collectSink();
    const stderrLines: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { stderrLines.push(a.join(" ")); };

    const stub: any = async (opts: any) => {
      const observer = (await new Promise<EventObserver>((resolve) => {
        const fakeLog: any = { addEventObserver: (fn: EventObserver) => { resolve(fn); return () => {}; }, logEvent: () => {} };
        opts.onLogger?.(fakeLog);
      }));
      observer({ type: "run_start", runId: "r", cardId: "a", maxTurns: 20 } as any);
      observer({ type: "run_end", status: "pass", usage: { turns: 1 } } as any);
      return { runId: "r", outDir: "/tmp/a", result: { status: "pass" } };
    };

    try {
      await runBatch(
        {
          scenarioPaths: ["a.md"],
          target: "x", adapterType: "cli", config: makeConfig(),
          silent: true, format: undefined, noColor: true,
          sink, isTTY: false,
        },
        stub,
      );
    } finally {
      console.error = origErr;
    }

    expect(sink.out).toBe("");
    expect(stderrLines.join("\n")).toContain("batch: 1 pass");
  });
});
```

Run: `bun test test/cli/batch.test.ts`
Expected: PASS — both behaviors are already implemented in `runBatch` (Task 5). If a test fails, fix the implementation in `src/cli/batch.ts` rather than the test.

- [ ] **Step 2: Commit**

```bash
git add test/cli/batch.test.ts
git commit -m "test(cli): batch — --format jsonl runId injection and --silent summary"
```

---

### Task 8: Wire `gauntlet batch` dispatch in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Goal:** Add the dispatch arm that turns the parsed `BatchArgs` into a `runBatch` call. Verify by hand with a smoke run.

- [ ] **Step 1: Add the case**

Edit `src/index.ts`. Add a new arm in the `switch (args.command)` block, just after `case "run":`:

```ts
    case "batch": {
      const config = await loadConfigOrExit(args.cli);
      await requireLlmCapableOrExit(config);
      const { runBatch } = await import("./cli/batch");
      const exitCode = await runBatch({
        scenarioPaths: args.scenarioPaths,
        target: args.cli.target ?? "",
        adapterType: args.adapter,
        config,
        silent: args.silent,
        format: args.format,
        noColor: args.noColor,
        sink: { write: (s: string) => process.stdout.write(s) },
        isTTY: Boolean(process.stdout.isTTY),
      });
      if (exitCode !== 0) process.exit(exitCode);
      break;
    }
```

- [ ] **Step 2: Manual smoke test**

Build a fixture batch and run it. Use the existing `cli` adapter against a no-op target (`true`). The card files don't need to be real here — even broken cards should produce a clean errored-row output.

Run: `bun run typecheck && bun test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): dispatch 'gauntlet batch' from main"
```

---

### Task 9: Integration test — `gauntlet batch` end-to-end with the cli adapter

**Files:**
- Create: `test/e2e/cli-batch.test.ts`

**Goal:** Drive `runBatch` against the real `runOne`, the real CLI adapter, and a scripted LLM client. Two cards: one passes, one fails (status = `fail`). Assert exit code, table output, and per-card evidence directories.

- [ ] **Step 1: Stub the LLM client at the client-resolve seam**

The cleanest way to inject a scripted client into `runOne` without changing its surface is to monkey-patch `createClient` for the test. Add a test-only helper at the top of the new test file using `mock.module`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mock } from "bun:test";

import { runBatch } from "../../src/cli/batch";
import { step, report, makeScriptedClient } from "./helpers";

const STORY_A = `---
id: cli-batch-a
title: A passes
status: ready
description: stub
acceptanceCriteria: []
---
`;

const STORY_B = `---
id: cli-batch-b
title: B fails
status: ready
description: stub
acceptanceCriteria: []
---
`;

describe("gauntlet batch — e2e against CLI adapter", () => {
  let projectRoot: string;
  let pathA: string;
  let pathB: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-batch-e2e-"));
    pathA = join(projectRoot, "a.md");
    pathB = join(projectRoot, "b.md");
    writeFileSync(pathA, STORY_A);
    writeFileSync(pathB, STORY_B);
  });

  test("two cards: one pass, one fail; exit code 1; both evidence dirs created", async () => {
    // The scripted client returns a single tool call: report_result.
    const passClient = makeScriptedClient([report("pass", "ok", "")]);
    const failClient = makeScriptedClient([report("fail", "nope", "")]);

    let i = 0;
    const clients = [passClient, failClient];
    mock.module("../../src/models/resolve", () => ({
      createClient: () => clients[i++],
      resolveProvider: () => "anthropic",
    }));

    const sink = { out: "", write(s: string) { this.out += s; } };

    const exitCode = await runBatch({
      scenarioPaths: [pathA, pathB],
      target: "true",       // CLI adapter spawns `true`, exits immediately
      adapterType: "cli",
      config: {
        projectRoot,
        port: 4400,
        defaultChrome: { host: "127.0.0.1", port: 9222 },
        defaultTurns: 5,
        defaultViewport: { width: 1440, height: 900 },
        saveScreencast: false,
        models: { agent: "claude-sonnet-4-6", fanout: undefined },
        sources: { defaultChrome: "default" },
      } as any,
      silent: false,
      format: undefined,
      noColor: true,
      sink,
      isTTY: false,
    });

    expect(exitCode).toBe(1);
    expect(sink.out).toContain("done (pass)");
    expect(sink.out).toContain("done (fail)");
    expect(sink.out).toContain("batch: 1 pass · 1 fail");

    // Evidence dirs exist under <projectRoot>/.gauntlet/results/
    const resultsRoot = join(projectRoot, ".gauntlet", "results");
    expect(existsSync(resultsRoot)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `bun test test/e2e/cli-batch.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full suite**

Run: `bun run check` (which is `typecheck + ui typecheck + ui build + test`).
Expected: All green.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/cli-batch.test.ts
git commit -m "test(e2e): gauntlet batch end-to-end with CLI adapter"
```

---

## Self-review checklist

After completing all tasks, verify:

1. **`gauntlet run a.md --target ...`** — single-card behavior identical to before.
2. **`gauntlet run a.md --target ... --silent`** — same one-line `runId:` on stderr, empty stdout.
3. **`gauntlet batch a.md b.md --target ...`** — live status table on TTY, append lines off-TTY.
4. **`gauntlet batch a.md b.md --target ... --format jsonl`** — every event on stdout has a `runId` field, no table.
5. **`gauntlet batch a.md b.md --target ... --silent`** — empty stdout; one summary line on stderr.
6. **`gauntlet batch a.md b.md --target ... --out /tmp`** — usage error (`--out` is rejected for batch).
7. **`gauntlet batch --target ...`** — usage error (no card paths).
8. **Exit codes:** all-pass → 0; any fail/investigate/errored → 1.
9. **Evidence on disk:** every card has `<.gauntlet>/results/<runId>/run.jsonl`, identical to single-card runs.
