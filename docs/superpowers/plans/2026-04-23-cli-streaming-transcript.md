# CLI streaming transcript — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [docs/superpowers/specs/2026-04-23-cli-streaming-transcript-design.md](../specs/2026-04-23-cli-streaming-transcript-design.md)

**Goal:** Make `gauntlet run` stream a readable transcript to stdout as events fire, with pretty output for TTYs, JSONL when piped, and `--silent` to suppress.

**Architecture:** Subscribe to the existing `EvidenceLogger.addEventObserver` channel — the same one that feeds the WebSocket broadcaster — and dispatch to a `StreamRenderer` (pretty or jsonl). All render logic lives under `src/cli/stream/`; `src/cli/run.ts` only does option resolution and wiring.

**Tech Stack:** TypeScript, Bun, `bun:test`, no new dependencies.

---

## File structure

**New files:**
- `src/cli/stream/renderer.ts` — `StreamRenderer` interface + `StreamEvent` type
- `src/cli/stream/wrap.ts` — soft-wrap at column, truncate-at-200
- `src/cli/stream/colors.ts` — ANSI palette + `paint(enabled)` helper
- `src/cli/stream/format.ts` — resolve `{silent, format, color, columns}` from CLI flags + env + TTY state
- `src/cli/stream/jsonl.ts` — `JsonlRenderer` — one event per line, verbatim
- `src/cli/stream/pretty.ts` — `PrettyRenderer` — Mock 2 format
- `src/cli/stream/attach.ts` — glue: `attachRenderer(logger, opts, out) => cleanup`
- `test/cli/stream/wrap.test.ts`
- `test/cli/stream/colors.test.ts`
- `test/cli/stream/format.test.ts`
- `test/cli/stream/jsonl.test.ts`
- `test/cli/stream/pretty.test.ts`
- `test/cli/stream/attach.test.ts`
- `test/cli/stream/fixtures/happy.jsonl`
- `test/cli/stream/fixtures/happy.pretty.txt`
- `test/cli/stream/fixtures/failing-tool.jsonl`
- `test/cli/stream/fixtures/failing-tool.pretty.txt`
- `test/cli/stream/fixtures/fatal.jsonl`
- `test/cli/stream/fixtures/fatal.pretty.txt`

**Modified files:**
- `src/cli/args.ts` — add `--silent`, `--format`, `--no-color` to `RUN_ALLOWED`, parse them, surface on `RunArgs`. Update `usage()` text.
- `src/cli/run.ts` — resolve stream options, attach renderer, suppress final stdout JSON when not silent, wrap fatal errors into a synthetic `run_error` event.
- `test/cli/args.test.ts` — add cases for the new flags.

---

## Deviation from the mock

Mock 2 renders tool_call and its timing/status on one line:

```
▸ click   { selector: ".login-btn" }   ✓ 420ms
```

To achieve that in a **streaming** output we'd need to print the call line, leave the cursor mid-line, and rewrite when the result arrives. Gauntlet's agent is serial within a turn (no interleaving events between call and result), so the rewrite is safe — but only on a TTY with color enabled.

The plan implements both paths:

- **TTY + color enabled:** print `▸ name args ⋯\n` on `tool_call`, then on `tool_result` use `\x1b[1A\x1b[2K` (cursor up, erase line) to rewrite the full line with timing.
- **No TTY or color disabled:** print `▸ name args` on `tool_call`, then `  ↳ ✓ 420ms` (or `↳ ✗ ...`) on a new indented line on `tool_result`.

Secondary lines (screenshot path, error block, hint) always follow on their own line regardless of mode.

---

## Tasks

### Task 1: Scaffolding — renderer interface and event type

**Files:**
- Create: `src/cli/stream/renderer.ts`

- [ ] **Step 1: Create the interface file**

```ts
// src/cli/stream/renderer.ts

/**
 * A structured entry as written to run.jsonl and delivered by
 * EvidenceLogger.addEventObserver. See src/evidence/logger.ts — we
 * mirror its shape verbatim and do not import its concrete types so
 * this module stays decoupled from the logger.
 */
export interface StreamEvent {
  eventId: number;
  parentEventId: number;
  ts: string;
  type: string;
  [k: string]: unknown;
}

export interface StreamRenderer {
  handle(event: StreamEvent): void;
  /** Flush any in-flight state (e.g. trailing newline, cleared spinner). */
  close(): void;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/stream/renderer.ts
git commit -m "feat(cli): scaffold StreamRenderer interface"
```

---

### Task 2: wrap + truncate utilities (TDD)

**Files:**
- Create: `src/cli/stream/wrap.ts`
- Test: `test/cli/stream/wrap.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/cli/stream/wrap.test.ts
import { describe, test, expect } from "bun:test";
import { softWrap, truncateArgs } from "../../../src/cli/stream/wrap";

describe("softWrap", () => {
  test("returns single line when under column width", () => {
    expect(softWrap("hello world", 80)).toEqual(["hello world"]);
  });

  test("wraps on whitespace at column boundary", () => {
    const out = softWrap("one two three four five", 10);
    expect(out).toEqual(["one two", "three four", "five"]);
  });

  test("breaks mid-word only when a single word exceeds width", () => {
    const out = softWrap("supercalifragilistic short", 10);
    expect(out[0].length).toBeLessThanOrEqual(10);
    expect(out.join(" ")).toContain("supercalifragilistic");
  });

  test("preserves explicit newlines", () => {
    expect(softWrap("a\nb", 80)).toEqual(["a", "b"]);
  });
});

describe("truncateArgs", () => {
  test("returns input unchanged when short enough", () => {
    expect(truncateArgs("abc", 200)).toBe("abc");
  });

  test("truncates with suffix indicating byte count when over limit", () => {
    const s = "x".repeat(250);
    const out = truncateArgs(s, 200);
    expect(out.length).toBeLessThan(s.length);
    expect(out).toMatch(/^x{1,200}…\s\(\+\d+\smore\)$/);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test test/cli/stream/wrap.test.ts`
Expected: fails with module-not-found for `src/cli/stream/wrap.ts`.

- [ ] **Step 3: Implement**

```ts
// src/cli/stream/wrap.ts

/**
 * Word-wrap `text` to `width` columns. Splits on whitespace; preserves
 * explicit newlines. Breaks a word mid-character only when that word
 * itself exceeds `width`.
 */
export function softWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= width) {
      out.push(rawLine);
      continue;
    }
    const words = rawLine.split(/\s+/);
    let line = "";
    for (const word of words) {
      if (!line) {
        if (word.length > width) {
          // Word too long to fit — hard-break it
          for (let i = 0; i < word.length; i += width) {
            const chunk = word.slice(i, i + width);
            if (i + width < word.length) out.push(chunk);
            else line = chunk;
          }
        } else {
          line = word;
        }
        continue;
      }
      if (line.length + 1 + word.length <= width) {
        line += " " + word;
      } else {
        out.push(line);
        line = word.length > width ? word.slice(0, width) : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Truncate a stringified tool-call args blob at `limit` characters,
 * replacing the tail with a `… (+N more)` marker counting remaining bytes.
 */
export function truncateArgs(s: string, limit: number): string {
  if (s.length <= limit) return s;
  const remaining = s.length - limit;
  return `${s.slice(0, limit)}… (+${remaining} more)`;
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test test/cli/stream/wrap.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/stream/wrap.ts test/cli/stream/wrap.test.ts
git commit -m "feat(cli): soft-wrap and arg-truncate utilities"
```

---

### Task 3: color palette with NO_COLOR bypass (TDD)

**Files:**
- Create: `src/cli/stream/colors.ts`
- Test: `test/cli/stream/colors.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/cli/stream/colors.test.ts
import { describe, test, expect } from "bun:test";
import { makePaint } from "../../../src/cli/stream/colors";

describe("makePaint", () => {
  test("wraps text in ANSI when enabled", () => {
    const p = makePaint(true);
    const out = p.cyan("hi");
    expect(out.startsWith("\x1b[")).toBe(true);
    expect(out.endsWith("\x1b[0m")).toBe(true);
    expect(out).toContain("hi");
  });

  test("returns raw text when disabled", () => {
    const p = makePaint(false);
    expect(p.cyan("hi")).toBe("hi");
    expect(p.bold("x")).toBe("x");
  });

  test("dim + green are distinct codes", () => {
    const p = makePaint(true);
    expect(p.dim("x")).not.toBe(p.green("x"));
  });

  test("supports chained formatting via bold + color", () => {
    const p = makePaint(true);
    const out = p.bold(p.red("err"));
    expect(out).toContain("err");
    expect(out.startsWith("\x1b[")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test test/cli/stream/colors.test.ts`
Expected: module-not-found failure.

- [ ] **Step 3: Implement**

```ts
// src/cli/stream/colors.ts

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

export type Paint = {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  cyan: (s: string) => string;
};

export function makePaint(enabled: boolean): Paint {
  if (!enabled) {
    const id = (s: string) => s;
    return { bold: id, dim: id, red: id, green: id, yellow: id, blue: id, magenta: id, cyan: id };
  }
  const wrap = (code: string) => (s: string) => `${code}${s}${CODES.reset}`;
  return {
    bold: wrap(CODES.bold),
    dim: wrap(CODES.dim),
    red: wrap(CODES.red),
    green: wrap(CODES.green),
    yellow: wrap(CODES.yellow),
    blue: wrap(CODES.blue),
    magenta: wrap(CODES.magenta),
    cyan: wrap(CODES.cyan),
  };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test test/cli/stream/colors.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/stream/colors.ts test/cli/stream/colors.test.ts
git commit -m "feat(cli): ANSI palette with NO_COLOR bypass"
```

---

### Task 4: format resolution (TDD)

**Files:**
- Create: `src/cli/stream/format.ts`
- Test: `test/cli/stream/format.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/cli/stream/format.test.ts
import { describe, test, expect } from "bun:test";
import { resolveStreamOptions } from "../../../src/cli/stream/format";

describe("resolveStreamOptions", () => {
  test("defaults: TTY + no NO_COLOR → pretty + color", () => {
    const o = resolveStreamOptions({ isTTY: true, env: {}, silent: false, format: undefined, noColor: false, columns: 100 });
    expect(o).toEqual({ silent: false, format: "pretty", color: true, columns: 100 });
  });

  test("non-TTY → jsonl, no color", () => {
    const o = resolveStreamOptions({ isTTY: false, env: {}, silent: false, format: undefined, noColor: false, columns: 100 });
    expect(o.format).toBe("jsonl");
    expect(o.color).toBe(false);
  });

  test("NO_COLOR env disables color even on TTY", () => {
    const o = resolveStreamOptions({ isTTY: true, env: { NO_COLOR: "1" }, silent: false, format: undefined, noColor: false, columns: 100 });
    expect(o.color).toBe(false);
    expect(o.format).toBe("pretty"); // format unaffected
  });

  test("--no-color flag disables color even on TTY", () => {
    const o = resolveStreamOptions({ isTTY: true, env: {}, silent: false, format: undefined, noColor: true, columns: 100 });
    expect(o.color).toBe(false);
  });

  test("--format pretty forces pretty even when piped", () => {
    const o = resolveStreamOptions({ isTTY: false, env: {}, silent: false, format: "pretty", noColor: false, columns: 100 });
    expect(o.format).toBe("pretty");
    expect(o.color).toBe(false); // still no color off-TTY
  });

  test("--format jsonl forces jsonl even on TTY", () => {
    const o = resolveStreamOptions({ isTTY: true, env: {}, silent: false, format: "jsonl", noColor: false, columns: 100 });
    expect(o.format).toBe("jsonl");
  });

  test("--silent takes precedence over everything", () => {
    const o = resolveStreamOptions({ isTTY: true, env: {}, silent: true, format: "pretty", noColor: false, columns: 100 });
    expect(o.silent).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test test/cli/stream/format.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement**

```ts
// src/cli/stream/format.ts

export type StreamFormat = "pretty" | "jsonl";

export interface StreamOptionsInput {
  isTTY: boolean;
  env: Record<string, string | undefined>;
  silent: boolean;
  format: StreamFormat | undefined;
  noColor: boolean;
  columns: number;
}

export interface StreamOptions {
  silent: boolean;
  format: StreamFormat;
  color: boolean;
  columns: number;
}

export function resolveStreamOptions(input: StreamOptionsInput): StreamOptions {
  const format: StreamFormat = input.format ?? (input.isTTY ? "pretty" : "jsonl");
  const noColorEnv = input.env.NO_COLOR !== undefined && input.env.NO_COLOR !== "";
  const color = !input.noColor && !noColorEnv && input.isTTY;
  return {
    silent: input.silent,
    format,
    color,
    columns: input.columns,
  };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test test/cli/stream/format.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/stream/format.ts test/cli/stream/format.test.ts
git commit -m "feat(cli): resolve stream options from TTY/env/flags"
```

---

### Task 5: JSONL renderer (TDD with fixture)

**Files:**
- Create: `src/cli/stream/jsonl.ts`
- Create: `test/cli/stream/fixtures/happy.jsonl`
- Test: `test/cli/stream/jsonl.test.ts`

- [ ] **Step 1: Create the happy-path fixture**

Write file `test/cli/stream/fixtures/happy.jsonl` (one JSON object per line — these are real run.jsonl shapes):

```jsonl
{"eventId":1,"parentEventId":0,"ts":"2026-04-23T10:00:00.000Z","type":"run_start","runId":"r-8f21","cardId":"login-flow","target":"https://example.com","provider":"anthropic","model":"claude-sonnet-4-6","adapter":"web","maxTurns":50,"toolTimeoutMs":30000,"contextTreeBytes":2048}
{"eventId":2,"parentEventId":1,"ts":"2026-04-23T10:00:00.500Z","type":"llm_request","turn":1,"messageCount":2}
{"eventId":3,"parentEventId":2,"ts":"2026-04-23T10:00:02.000Z","type":"llm_response","turn":1,"stopReason":"tool_use","text":"I'll take a screenshot first.","thinking":[{"text":"Let me see the page state."}],"toolCalls":[{"id":"t1","name":"screenshot","arguments":{}}],"usage":{"inputTokens":1200,"outputTokens":80},"rawAssistantMessage":null}
{"eventId":4,"parentEventId":3,"ts":"2026-04-23T10:00:02.100Z","type":"tool_call","turn":1,"toolUseId":"t1","name":"screenshot","arguments":{}}
{"eventId":5,"parentEventId":4,"ts":"2026-04-23T10:00:02.280Z","type":"tool_result","turn":1,"toolUseId":"t1","name":"screenshot","durationMs":180,"text":"","image":"screenshots/001.png","error":false}
{"eventId":6,"parentEventId":5,"ts":"2026-04-23T10:00:03.000Z","type":"run_end","status":"pass","summary":"Login succeeded","reasoning":"Saw dashboard after submit","observationCount":3,"durationMs":3000,"usage":{"inputTokens":1200,"outputTokens":80,"turns":1}}
```

- [ ] **Step 2: Write the failing test**

```ts
// test/cli/stream/jsonl.test.ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { JsonlRenderer } from "../../../src/cli/stream/jsonl";

function collect(): { out: string; write: (s: string) => void } {
  let out = "";
  return { get out() { return out; }, write: (s: string) => { out += s; } } as any;
}

describe("JsonlRenderer", () => {
  test("writes each event as one JSON line verbatim", () => {
    const fixture = readFileSync(join(import.meta.dir, "fixtures/happy.jsonl"), "utf8");
    const events = fixture.split("\n").filter(Boolean).map((l) => JSON.parse(l));

    const sink = collect();
    const r = new JsonlRenderer(sink);
    for (const e of events) r.handle(e);
    r.close();

    const lines = sink.out.split("\n").filter(Boolean);
    expect(lines.length).toBe(events.length);
    for (let i = 0; i < events.length; i++) {
      expect(JSON.parse(lines[i])).toEqual(events[i]);
    }
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `bun test test/cli/stream/jsonl.test.ts`
Expected: module-not-found.

- [ ] **Step 4: Implement**

```ts
// src/cli/stream/jsonl.ts
import type { StreamEvent, StreamRenderer } from "./renderer";

export interface WriteSink {
  write(s: string): void;
}

export class JsonlRenderer implements StreamRenderer {
  constructor(private sink: WriteSink) {}

  handle(event: StreamEvent): void {
    this.sink.write(JSON.stringify(event) + "\n");
  }

  close(): void {
    // nothing to flush — each handle() already wrote a complete line
  }
}
```

- [ ] **Step 5: Run test — verify it passes**

Run: `bun test test/cli/stream/jsonl.test.ts`
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add src/cli/stream/jsonl.ts test/cli/stream/jsonl.test.ts test/cli/stream/fixtures/happy.jsonl
git commit -m "feat(cli): JsonlRenderer — verbatim events on stdout"
```

---

### Task 6: PrettyRenderer — run_start + run_end panels

**Files:**
- Create: `src/cli/stream/pretty.ts` (partial — grows in later tasks)
- Create: `test/cli/stream/fixtures/happy.pretty.txt` (partial — grows in later tasks)
- Test: `test/cli/stream/pretty.test.ts`

**Note:** Later tasks append to `happy.pretty.txt` and `pretty.ts`. Each task updates the golden file to reflect what the renderer should now produce for the full `happy.jsonl` fixture.

- [ ] **Step 1: Create the initial golden file**

Write `test/cli/stream/fixtures/happy.pretty.txt` (only run_start block for now — the test filters the fixture to just run_start + run_end and expects the two panels):

```
──────────────────────────────────────────────────────
  runId     r-8f21
  card      login-flow
  target    https://example.com
  model     claude-sonnet-4-6
  adapter   web
  max turns 50
──────────────────────────────────────────────────────

─── Run complete ────────────────────────────── ✓ pass
  runId     r-8f21
  duration  3.0s
  turns     1 / 50
  usage     in 1.2k  out 80
  summary   Login succeeded
```

- [ ] **Step 2: Write the failing test**

```ts
// test/cli/stream/pretty.test.ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { PrettyRenderer } from "../../../src/cli/stream/pretty";
import type { StreamEvent } from "../../../src/cli/stream/renderer";

function loadFixture(name: string): { events: StreamEvent[]; expected: string } {
  const jsonl = readFileSync(join(import.meta.dir, `fixtures/${name}.jsonl`), "utf8");
  const expected = readFileSync(join(import.meta.dir, `fixtures/${name}.pretty.txt`), "utf8");
  const events = jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { events, expected };
}

function collect(): { out: string; write: (s: string) => void } {
  const obj = { out: "", write(s: string) { obj.out += s; } };
  return obj;
}

describe("PrettyRenderer", () => {
  test("renders run_start and run_end panels (happy fixture, start/end only)", () => {
    const { events, expected } = loadFixture("happy");
    const startAndEnd = events.filter((e) => e.type === "run_start" || e.type === "run_end");

    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    for (const e of startAndEnd) r.handle(e);
    r.close();

    expect(sink.out).toBe(expected);
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: module-not-found.

- [ ] **Step 4: Implement run_start + run_end handlers**

```ts
// src/cli/stream/pretty.ts
import type { StreamEvent, StreamRenderer } from "./renderer";
import type { WriteSink } from "./jsonl";
import { makePaint, type Paint } from "./colors";

const RULE = "──────────────────────────────────────────────────────";

export interface PrettyOptions {
  color: boolean;
  columns: number;
}

export class PrettyRenderer implements StreamRenderer {
  private paint: Paint;
  constructor(private sink: WriteSink, private opts: PrettyOptions) {
    this.paint = makePaint(opts.color);
  }

  handle(event: StreamEvent): void {
    switch (event.type) {
      case "run_start":
        this.renderRunStart(event);
        return;
      case "run_end":
        this.renderRunEnd(event);
        return;
      default:
        return;
    }
  }

  close(): void {
    // nothing to flush yet
  }

  private write(line: string): void {
    this.sink.write(line + "\n");
  }

  private renderRunStart(e: StreamEvent): void {
    const p = this.paint;
    this.write(p.dim(RULE));
    this.write(`  ${p.dim("runId    ")} ${e.runId}`);
    this.write(`  ${p.dim("card     ")} ${e.cardId}`);
    this.write(`  ${p.dim("target   ")} ${e.target ?? "—"}`);
    this.write(`  ${p.dim("model    ")} ${e.model}`);
    this.write(`  ${p.dim("adapter  ")} ${e.adapter}`);
    this.write(`  ${p.dim("max turns")} ${e.maxTurns}`);
    this.write(p.dim(RULE));
    this.write("");
  }

  private renderRunEnd(e: StreamEvent): void {
    const p = this.paint;
    const status = String(e.status);
    const ok = status === "pass";
    const mark = ok ? p.green("✓") : p.red("✗");
    const statusTxt = ok ? p.green(status) : p.red(status);
    this.write(`${p.dim("─── Run complete ──────────────────────────────")} ${mark} ${statusTxt}`);
    this.write(`  ${p.dim("runId   ")} ${e.runId ?? ""}`);
    this.write(`  ${p.dim("duration")} ${formatDuration(Number(e.durationMs ?? 0))}`);
    const usage = e.usage as Record<string, number> | undefined;
    const turns = usage?.turns ?? 0;
    const max = e.maxTurns ?? "?";
    this.write(`  ${p.dim("turns   ")} ${turns} / ${max}`);
    if (usage) {
      const parts = [
        `in ${formatThousands(usage.inputTokens)}`,
        `out ${formatThousands(usage.outputTokens)}`,
      ];
      if (usage.cacheReadInputTokens) parts.push(`cache ${formatThousands(usage.cacheReadInputTokens)}`);
      this.write(`  ${p.dim("usage   ")} ${parts.join("  ")}`);
    }
    if (e.summary) this.write(`  ${p.dim("summary ")} ${e.summary}`);
  }
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(1)}s`;
}

function formatThousands(n: number | undefined): string {
  if (n === undefined) return "0";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
```

Also update `run_end` to pull `maxTurns` from the preceding `run_start`. Change the renderer to cache it:

Replace the class body above with this modified version (add `private maxTurns` and fill it on `run_start`):

```ts
export class PrettyRenderer implements StreamRenderer {
  private paint: Paint;
  private maxTurns: number | undefined;
  constructor(private sink: WriteSink, private opts: PrettyOptions) {
    this.paint = makePaint(opts.color);
  }

  // ...same handle() / close() / write()...

  private renderRunStart(e: StreamEvent): void {
    this.maxTurns = Number(e.maxTurns ?? 0);
    // ...unchanged body...
  }

  private renderRunEnd(e: StreamEvent): void {
    // ...same, but replace `e.maxTurns ?? "?"` with `this.maxTurns ?? "?"`...
  }
}
```

- [ ] **Step 5: Run test — verify it passes**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: 1 test passes, byte-for-byte match against the golden file.

- [ ] **Step 6: Commit**

```bash
git add src/cli/stream/pretty.ts test/cli/stream/pretty.test.ts test/cli/stream/fixtures/happy.pretty.txt
git commit -m "feat(cli): PrettyRenderer — run_start and run_end panels"
```

---

### Task 7: PrettyRenderer — turn header + thinking + assistant

**Files:**
- Modify: `src/cli/stream/pretty.ts`
- Modify: `test/cli/stream/pretty.test.ts`
- Modify: `test/cli/stream/fixtures/happy.pretty.txt`

- [ ] **Step 1: Update the golden file**

Replace `test/cli/stream/fixtures/happy.pretty.txt` with the full expected output including the turn:

```
──────────────────────────────────────────────────────
  runId     r-8f21
  card      login-flow
  target    https://example.com
  model     claude-sonnet-4-6
  adapter   web
  max turns 50
──────────────────────────────────────────────────────

▎ Turn 1 · claude-sonnet-4-6 · turn 1 / 50

  ~ thinking
    Let me see the page state.

  = assistant
    I'll take a screenshot first.

─── Run complete ────────────────────────────── ✓ pass
  runId     r-8f21
  duration  3.0s
  turns     1 / 50
  usage     in 1.2k  out 80
  summary   Login succeeded
```

- [ ] **Step 2: Expand the test to consume the full fixture**

Replace the single test body to use `events` (not just run_start/run_end) but filter out `tool_call`/`tool_result`/`llm_request` for this task:

```ts
describe("PrettyRenderer", () => {
  test("renders full happy fixture excluding tool + llm_request events", () => {
    const { events, expected } = loadFixture("happy");
    const filtered = events.filter((e) =>
      e.type !== "tool_call" && e.type !== "tool_result" && e.type !== "llm_request"
    );

    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    for (const e of filtered) r.handle(e);
    r.close();

    expect(sink.out).toBe(expected);
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: output diff — missing turn header, thinking, assistant blocks.

- [ ] **Step 4: Implement `llm_response` handler**

Add to `PrettyRenderer`:

```ts
// Add to switch in handle():
case "llm_response":
  this.renderLlmResponse(event);
  return;

// New method:
private renderLlmResponse(e: StreamEvent): void {
  const p = this.paint;
  const turn = Number(e.turn ?? 0);
  // Model is carried on run_start and cached. No leading blank here —
  // the preceding section (run_start or tool_result) emits its own
  // trailing blank.
  const modelLabel = this.model ?? "";
  const header = `${p.cyan("▎")} ${p.bold(`Turn ${turn}`)} ${p.dim(`· ${modelLabel} · turn ${turn} / ${this.maxTurns ?? "?"}`)}`;
  this.write(header);

  const thinking = (e.thinking ?? []) as Array<{ text: string }>;
  for (const th of thinking) {
    this.write("");
    this.write(`  ${p.magenta("~ thinking")}`);
    for (const line of softWrap(th.text, this.opts.columns - 4)) {
      this.write(`    ${p.dim(line)}`);
    }
  }

  const text = String(e.text ?? "");
  if (text.length > 0) {
    this.write("");
    this.write(`  ${p.yellow("= assistant")}`);
    for (const line of softWrap(text, this.opts.columns - 4)) {
      this.write(`    ${line}`);
    }
  }
  this.write("");
}
```

Also add `private model: string | undefined` field, set it on `run_start` (`this.model = String(e.model);`), and add `import { softWrap } from "./wrap";` at the top.

- [ ] **Step 5: Run test — verify it passes**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: pass, byte-for-byte.

- [ ] **Step 6: Commit**

```bash
git add src/cli/stream/pretty.ts test/cli/stream/pretty.test.ts test/cli/stream/fixtures/happy.pretty.txt
git commit -m "feat(cli): PrettyRenderer — turn header, thinking, assistant"
```

---

### Task 8: PrettyRenderer — tool_call + tool_result pairs (with inline-rewrite mode)

**Files:**
- Modify: `src/cli/stream/pretty.ts`
- Modify: `test/cli/stream/pretty.test.ts`
- Modify: `test/cli/stream/fixtures/happy.pretty.txt`
- Create: `test/cli/stream/fixtures/failing-tool.jsonl`
- Create: `test/cli/stream/fixtures/failing-tool.pretty.txt`

- [ ] **Step 1: Update happy golden (non-TTY / no-color path — two-line format)**

Insert tool rows between assistant block and run_end. Full new content:

```
──────────────────────────────────────────────────────
  runId     r-8f21
  card      login-flow
  target    https://example.com
  model     claude-sonnet-4-6
  adapter   web
  max turns 50
──────────────────────────────────────────────────────

▎ Turn 1 · claude-sonnet-4-6 · turn 1 / 50

  ~ thinking
    Let me see the page state.

  = assistant
    I'll take a screenshot first.

  ▸ screenshot {}
    ↳ ✓ 180ms
      → screenshots/001.png

─── Run complete ────────────────────────────── ✓ pass
  runId     r-8f21
  duration  3.0s
  turns     1 / 50
  usage     in 1.2k  out 80
  summary   Login succeeded
```

- [ ] **Step 2: Create the failing-tool fixture**

Write `test/cli/stream/fixtures/failing-tool.jsonl`:

```jsonl
{"eventId":1,"parentEventId":0,"ts":"2026-04-23T10:00:00.000Z","type":"run_start","runId":"r-ff01","cardId":"login-flow","target":"https://example.com","provider":"anthropic","model":"claude-sonnet-4-6","adapter":"web","maxTurns":50,"toolTimeoutMs":30000,"contextTreeBytes":2048}
{"eventId":2,"parentEventId":1,"ts":"2026-04-23T10:00:02.000Z","type":"llm_response","turn":1,"stopReason":"tool_use","text":"Clicking login.","thinking":[],"toolCalls":[{"id":"t1","name":"click","arguments":{"selector":".nonexistent"}}],"usage":{"inputTokens":1200,"outputTokens":40},"rawAssistantMessage":null}
{"eventId":3,"parentEventId":2,"ts":"2026-04-23T10:00:02.100Z","type":"tool_call","turn":1,"toolUseId":"t1","name":"click","arguments":{"selector":".nonexistent"}}
{"eventId":4,"parentEventId":3,"ts":"2026-04-23T10:00:03.280Z","type":"tool_result","turn":1,"toolUseId":"t1","name":"click","durationMs":1180,"text":"element not found: waited 1s for \".nonexistent\"","error":true,"hint":"closest match: \".login-button\""}
{"eventId":5,"parentEventId":4,"ts":"2026-04-23T10:00:03.500Z","type":"run_end","status":"fail","summary":"Could not find login button","reasoning":"Selector did not match","observationCount":1,"durationMs":3500,"usage":{"inputTokens":1200,"outputTokens":40,"turns":1}}
```

Write `test/cli/stream/fixtures/failing-tool.pretty.txt`:

```
──────────────────────────────────────────────────────
  runId     r-ff01
  card      login-flow
  target    https://example.com
  model     claude-sonnet-4-6
  adapter   web
  max turns 50
──────────────────────────────────────────────────────

▎ Turn 1 · claude-sonnet-4-6 · turn 1 / 50

  = assistant
    Clicking login.

  ▸ click {"selector":".nonexistent"}
    ↳ ✗ 1180ms
      ╵ error  element not found: waited 1s for ".nonexistent"
      ╵ hint   closest match: ".login-button"

─── Run complete ────────────────────────────── ✗ fail
  runId     r-ff01
  duration  3.5s
  turns     1 / 50
  usage     in 1.2k  out 40
  summary   Could not find login button
```

- [ ] **Step 3: Add the failing-tool test case**

```ts
// Append inside describe("PrettyRenderer", () => { ... })
test("renders failing tool call with error + hint lines", () => {
  const { events, expected } = loadFixture("failing-tool");
  const sink = collect();
  const r = new PrettyRenderer(sink, { color: false, columns: 100 });
  for (const e of events) r.handle(e);
  r.close();
  expect(sink.out).toBe(expected);
});
```

And update the happy test to pass the full event list (no filter):

```ts
test("renders full happy fixture", () => {
  const { events, expected } = loadFixture("happy");
  const sink = collect();
  const r = new PrettyRenderer(sink, { color: false, columns: 100 });
  for (const e of events) r.handle(e);
  r.close();
  expect(sink.out).toBe(expected);
});
```

- [ ] **Step 4: Run tests — verify they fail**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: diff — tool rows missing from happy; failing fixture diff too.

- [ ] **Step 5: Implement tool_call + tool_result handlers**

Add to `PrettyRenderer`:

```ts
// Add to switch in handle():
case "tool_call":
  this.renderToolCall(event);
  return;
case "tool_result":
  this.renderToolResult(event);
  return;

// New methods:
private renderToolCall(e: StreamEvent): void {
  const p = this.paint;
  const name = String(e.name ?? "");
  const args = truncateArgs(JSON.stringify(e.arguments ?? {}), 200);
  // Non-inline-rewrite path: just print the call line. Inline-rewrite
  // is handled in a follow-up task where we track TTY + color state.
  this.write(`  ${p.cyan("▸")} ${p.bold(name)} ${p.dim(args)}`);
}

private renderToolResult(e: StreamEvent): void {
  const p = this.paint;
  const ms = Number(e.durationMs ?? 0);
  const err = Boolean(e.error);
  const timing = `${ms}ms`;
  if (err) {
    this.write(`    ${p.dim("↳")} ${p.red("✗")} ${p.dim(timing)}`);
    const text = String(e.text ?? "");
    if (text) this.write(`      ${p.dim("╵ error ")} ${text}`);
    if (e.hint) this.write(`      ${p.dim("╵ hint  ")} ${String(e.hint)}`);
  } else {
    this.write(`    ${p.dim("↳")} ${p.green("✓")} ${p.dim(timing)}`);
    if (e.image)       this.write(`      ${p.dim("→")} ${p.blue(String(e.image))}`);
    else if (e.artifact)    this.write(`      ${p.dim("→")} ${p.blue(String(e.artifact))}`);
    else if (e.capturePath) this.write(`      ${p.dim("→")} ${p.blue(String(e.capturePath))}`);
  }
  // Trailing blank line so the following section (another turn or run_end)
  // has clean separation without needing its own leading blank.
  this.write("");
}
```

Also: `import { truncateArgs } from "./wrap";` at top (add to existing import).

- [ ] **Step 6: Run tests — verify they pass**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: 2 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/cli/stream/pretty.ts test/cli/stream/pretty.test.ts test/cli/stream/fixtures/happy.pretty.txt test/cli/stream/fixtures/failing-tool.jsonl test/cli/stream/fixtures/failing-tool.pretty.txt
git commit -m "feat(cli): PrettyRenderer — tool_call and tool_result with errors"
```

---

### Task 9: PrettyRenderer — event meta + run_error fatal panel

**Files:**
- Modify: `src/cli/stream/pretty.ts`
- Modify: `test/cli/stream/pretty.test.ts`
- Create: `test/cli/stream/fixtures/fatal.jsonl`
- Create: `test/cli/stream/fixtures/fatal.pretty.txt`

- [ ] **Step 1: Create the fatal fixture**

`test/cli/stream/fixtures/fatal.jsonl`:

```jsonl
{"eventId":1,"parentEventId":0,"ts":"2026-04-23T10:00:00.000Z","type":"run_start","runId":"r-fa01","cardId":"login-flow","target":"https://example.com","provider":"anthropic","model":"claude-sonnet-4-6","adapter":"web","maxTurns":50,"toolTimeoutMs":30000,"contextTreeBytes":2048}
{"eventId":2,"parentEventId":1,"ts":"2026-04-23T10:00:01.000Z","type":"llm_response","turn":1,"stopReason":"tool_use","text":"","thinking":[],"toolCalls":[],"usage":{"inputTokens":1200,"outputTokens":10},"rawAssistantMessage":null}
{"eventId":3,"parentEventId":2,"ts":"2026-04-23T10:00:01.500Z","type":"event","name":"tool_result_text_oversize","turn":1,"toolName":"read_screen","bytes":65536,"artifact":"artifacts/001.txt"}
{"eventId":4,"parentEventId":3,"ts":"2026-04-23T10:00:02.000Z","type":"event","name":"run_error","turn":1,"message":"anthropic: rate_limit_error (40s remaining)"}
```

`test/cli/stream/fixtures/fatal.pretty.txt`:

```
──────────────────────────────────────────────────────
  runId     r-fa01
  card      login-flow
  target    https://example.com
  model     claude-sonnet-4-6
  adapter   web
  max turns 50
──────────────────────────────────────────────────────

▎ Turn 1 · claude-sonnet-4-6 · turn 1 / 50

  · tool_result_text_oversize turn=1 toolName=read_screen bytes=65536 artifact=artifacts/001.txt

─── Run failed ──────────────────────────────── ✗ error
  runId     r-fa01
  turn      1 / 50
  error     anthropic: rate_limit_error (40s remaining)
```

- [ ] **Step 2: Add the fatal test case**

```ts
test("renders event (meta) line and run_error fatal panel", () => {
  const { events, expected } = loadFixture("fatal");
  const sink = collect();
  const r = new PrettyRenderer(sink, { color: false, columns: 100 });
  for (const e of events) r.handle(e);
  r.close();
  expect(sink.out).toBe(expected);
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: diff — event line and fatal panel missing.

- [ ] **Step 4: Implement event + run_error handlers**

Add to `PrettyRenderer`:

```ts
// Add to switch in handle():
case "event":
  if (event.name === "run_error") this.renderRunError(event);
  else this.renderEventMeta(event);
  return;

// New methods:
private renderEventMeta(e: StreamEvent): void {
  const p = this.paint;
  const { type: _t, eventId: _id, parentEventId: _pid, ts: _ts, name, ...rest } = e;
  const parts = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  this.write(`  ${p.dim(`· ${name} ${parts.join(" ")}`)}`);
}

private renderRunError(e: StreamEvent): void {
  const p = this.paint;
  const turn = Number(e.turn ?? 0);
  this.write("");
  this.write(`${p.dim("─── Run failed ────────────────────────────────")} ${p.red("✗")} ${p.red("error")}`);
  this.write(`  ${p.dim("runId   ")} ${this.runId ?? ""}`);
  this.write(`  ${p.dim("turn    ")} ${turn} / ${this.maxTurns ?? "?"}`);
  this.write(`  ${p.dim("error   ")} ${String(e.message ?? "")}`);
}
```

Also store `this.runId` in `renderRunStart`: add `private runId: string | undefined;` and `this.runId = String(e.runId);`.

- [ ] **Step 5: Run test — verify it passes**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: 3 tests pass (happy, failing-tool, fatal).

- [ ] **Step 6: Commit**

```bash
git add src/cli/stream/pretty.ts test/cli/stream/pretty.test.ts test/cli/stream/fixtures/fatal.jsonl test/cli/stream/fixtures/fatal.pretty.txt
git commit -m "feat(cli): PrettyRenderer — event meta lines and run_error panel"
```

---

### Task 10: PrettyRenderer — inline-rewrite path for TTY + color

**Files:**
- Modify: `src/cli/stream/pretty.ts`
- Modify: `test/cli/stream/pretty.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("inline-rewrite mode emits a pending call line, then CR+erase + final line (TTY/color on)", () => {
  const events = [
    { eventId: 1, parentEventId: 0, ts: "t", type: "tool_call", turn: 1, toolUseId: "t1", name: "click", arguments: { selector: ".x" } },
    { eventId: 2, parentEventId: 1, ts: "t", type: "tool_result", turn: 1, toolUseId: "t1", name: "click", durationMs: 420, text: "", error: false },
  ];
  const sink = collect();
  const r = new PrettyRenderer(sink, { color: true, columns: 100 });
  for (const e of events) r.handle(e as any);
  r.close();
  // Expect a pending ellipsis, then the ANSI cursor-up + erase sequence, then the final line
  expect(sink.out).toContain("⋯");
  expect(sink.out).toContain("\x1b[1A\x1b[2K");
  expect(sink.out).toContain("✓");
  expect(sink.out).toContain("420ms");
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: missing `\x1b[1A\x1b[2K` or `⋯`.

- [ ] **Step 3: Implement the inline-rewrite branch**

Modify `renderToolCall` and `renderToolResult` to switch on `this.opts.color`:

```ts
private renderToolCall(e: StreamEvent): void {
  const p = this.paint;
  const name = String(e.name ?? "");
  const args = truncateArgs(JSON.stringify(e.arguments ?? {}), 200);
  const base = `  ${p.cyan("▸")} ${p.bold(name)} ${p.dim(args)}`;
  if (this.opts.color) {
    // Inline-rewrite path: include a trailing pending marker so the user sees progress.
    this.write(`${base} ${p.dim("⋯")}`);
    this.pendingRewrite = { base };
  } else {
    this.write(base);
    this.pendingRewrite = undefined;
  }
}

private renderToolResult(e: StreamEvent): void {
  const p = this.paint;
  const ms = Number(e.durationMs ?? 0);
  const err = Boolean(e.error);
  const timing = `${ms}ms`;

  if (this.pendingRewrite && this.opts.color) {
    // Erase the previous line and rewrite with the final timing inline.
    const mark = err ? p.red("✗") : p.green("✓");
    this.sink.write("\x1b[1A\x1b[2K"); // cursor up, erase line
    this.write(`${this.pendingRewrite.base}   ${mark} ${p.dim(timing)}`);
    this.pendingRewrite = undefined;
  } else {
    // Two-line fallback — same as the existing no-color path.
    if (err) this.write(`    ${p.dim("↳")} ${p.red("✗")} ${p.dim(timing)}`);
    else     this.write(`    ${p.dim("↳")} ${p.green("✓")} ${p.dim(timing)}`);
  }

  // Secondary lines always print as a separate indented line regardless of mode.
  if (err) {
    const text = String(e.text ?? "");
    if (text) this.write(`      ${p.dim("╵ error ")} ${text}`);
    if (e.hint) this.write(`      ${p.dim("╵ hint  ")} ${String(e.hint)}`);
  } else {
    if (e.image)            this.write(`      ${p.dim("→")} ${p.blue(String(e.image))}`);
    else if (e.artifact)    this.write(`      ${p.dim("→")} ${p.blue(String(e.artifact))}`);
    else if (e.capturePath) this.write(`      ${p.dim("→")} ${p.blue(String(e.capturePath))}`);
  }
  this.write(""); // trailing blank — matches the non-color path
}
```

Add field declaration on the class:

```ts
private pendingRewrite: { base: string } | undefined;
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: 4 tests pass. The existing no-color goldens still match because we only touch the `opts.color=true` branch.

- [ ] **Step 5: Commit**

```bash
git add src/cli/stream/pretty.ts test/cli/stream/pretty.test.ts
git commit -m "feat(cli): PrettyRenderer — inline tool-result rewrite on TTY"
```

---

### Task 11: PrettyRenderer — waiting-for-model spinner

**Files:**
- Modify: `src/cli/stream/pretty.ts`
- Modify: `test/cli/stream/pretty.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("spinner writes waiting line on llm_request and clears on next event (TTY/color on)", () => {
  const sink = collect();
  const r = new PrettyRenderer(sink, { color: true, columns: 100 });
  r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "run_start", runId: "r", cardId: "c", target: "t", provider: "a", model: "claude-sonnet-4-6", adapter: "web", maxTurns: 50, toolTimeoutMs: 1, contextTreeBytes: 0 } as any);
  r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "llm_request", turn: 1, messageCount: 1 } as any);
  // Spinner writes once synchronously — we don't advance timers in this test
  expect(sink.out).toContain("waiting for model");
  r.handle({ eventId: 3, parentEventId: 2, ts: "t", type: "llm_response", turn: 1, stopReason: "end_turn", text: "", thinking: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, rawAssistantMessage: null } as any);
  r.close();
  // After the next event, a CR+erase sequence should clear the spinner line.
  expect(sink.out).toContain("\r\x1b[2K");
});

test("spinner is not emitted when color is off", () => {
  const sink = collect();
  const r = new PrettyRenderer(sink, { color: false, columns: 100 });
  r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "run_start", runId: "r", cardId: "c", target: "t", provider: "a", model: "claude-sonnet-4-6", adapter: "web", maxTurns: 50, toolTimeoutMs: 1, contextTreeBytes: 0 } as any);
  r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "llm_request", turn: 1, messageCount: 1 } as any);
  expect(sink.out).not.toContain("waiting for model");
  r.close();
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: "waiting for model" missing in first test.

- [ ] **Step 3: Implement the spinner**

Add to `PrettyRenderer`:

```ts
// Add field:
private spinnerTimer: ReturnType<typeof setInterval> | undefined;
private spinnerStartMs = 0;
private spinnerActive = false;

// Replace the existing handle() with this version. The only changes are
// (1) the spinner-clear guard at the top and (2) the new llm_request case.
handle(event: StreamEvent): void {
  if (this.spinnerActive && event.type !== "llm_request") {
    this.clearSpinner();
  }
  switch (event.type) {
    case "run_start":
      this.renderRunStart(event);
      return;
    case "llm_request":
      if (this.opts.color) this.startSpinner();
      return;
    case "llm_response":
      this.renderLlmResponse(event);
      return;
    case "tool_call":
      this.renderToolCall(event);
      return;
    case "tool_result":
      this.renderToolResult(event);
      return;
    case "event":
      if (event.name === "run_error") this.renderRunError(event);
      else this.renderEventMeta(event);
      return;
    case "run_end":
      this.renderRunEnd(event);
      return;
    default:
      return;
  }
}

close(): void {
  if (this.spinnerActive) this.clearSpinner();
}

private startSpinner(): void {
  this.spinnerActive = true;
  this.spinnerStartMs = Date.now();
  this.renderSpinnerLine();
  this.spinnerTimer = setInterval(() => this.renderSpinnerLine(), 1000);
}

private clearSpinner(): void {
  if (this.spinnerTimer) clearInterval(this.spinnerTimer);
  this.spinnerTimer = undefined;
  this.spinnerActive = false;
  this.sink.write("\r\x1b[2K");
}

private renderSpinnerLine(): void {
  const elapsed = Math.floor((Date.now() - this.spinnerStartMs) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  this.sink.write(`\r\x1b[2K${this.paint.dim(`⋯ waiting for model · ${mm}:${ss}`)}`);
}
```

Note the `handle()` header edit: the existing `handle()` needs the "clear spinner first if active" guard at the top. The existing `switch` stays; only an `llm_request` case is added.

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test test/cli/stream/pretty.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/stream/pretty.ts test/cli/stream/pretty.test.ts
git commit -m "feat(cli): PrettyRenderer — waiting-for-model spinner on TTY"
```

---

### Task 12: attach helper (TDD)

**Files:**
- Create: `src/cli/stream/attach.ts`
- Test: `test/cli/stream/attach.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/cli/stream/attach.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EvidenceLogger } from "../../../src/evidence/logger";
import { attachRenderer } from "../../../src/cli/stream/attach";

describe("attachRenderer", () => {
  let outDir: string;
  let logger: EvidenceLogger;
  let captured = "";
  const sink = { write: (s: string) => { captured += s; } };

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "gauntlet-stream-"));
    logger = new EvidenceLogger(outDir);
    captured = "";
  });

  afterEach(() => rmSync(outDir, { recursive: true, force: true }));

  test("silent=true attaches no observer — nothing written to sink", () => {
    const cleanup = attachRenderer(logger, { silent: true, format: "pretty", color: false, columns: 100 }, sink);
    logger.logEvent("x", { a: 1 });
    cleanup();
    expect(captured).toBe("");
  });

  test("format=jsonl produces one JSON line per event", () => {
    const cleanup = attachRenderer(logger, { silent: false, format: "jsonl", color: false, columns: 100 }, sink);
    logger.logEvent("tick", { n: 1 });
    logger.logEvent("tick", { n: 2 });
    cleanup();
    const lines = captured.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    const p1 = JSON.parse(lines[0]);
    expect(p1.type).toBe("event");
    expect(p1.name).toBe("tick");
  });

  test("format=pretty writes something human-readable for run_start", () => {
    const cleanup = attachRenderer(logger, { silent: false, format: "pretty", color: false, columns: 100 }, sink);
    logger.logRunStart({ runId: "r1", cardId: "c", target: "t", provider: "a", model: "m", adapter: "web", maxTurns: 50, toolTimeoutMs: 1, contextTreeBytes: 0 });
    cleanup();
    expect(captured).toContain("runId");
    expect(captured).toContain("r1");
  });

  test("cleanup stops further writes", () => {
    const cleanup = attachRenderer(logger, { silent: false, format: "jsonl", color: false, columns: 100 }, sink);
    cleanup();
    logger.logEvent("after", {});
    expect(captured).toBe("");
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test test/cli/stream/attach.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement**

```ts
// src/cli/stream/attach.ts
import type { EvidenceLogger } from "../../evidence/logger";
import type { StreamOptions } from "./format";
import type { StreamRenderer } from "./renderer";
import { JsonlRenderer, type WriteSink } from "./jsonl";
import { PrettyRenderer } from "./pretty";

/**
 * Attach a stream renderer to an EvidenceLogger's event observer channel.
 * Returns a cleanup function that detaches the observer and flushes the
 * renderer. Callers should invoke cleanup exactly once, typically in a
 * finally block alongside adapter.close().
 */
export function attachRenderer(
  logger: EvidenceLogger,
  opts: StreamOptions,
  sink: WriteSink,
): () => void {
  if (opts.silent) return () => {};
  const renderer: StreamRenderer =
    opts.format === "jsonl"
      ? new JsonlRenderer(sink)
      : new PrettyRenderer(sink, { color: opts.color, columns: opts.columns });

  const unsubscribe = logger.addEventObserver((ev) => {
    renderer.handle(ev as any);
  });

  return () => {
    unsubscribe();
    renderer.close();
  };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test test/cli/stream/attach.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/stream/attach.ts test/cli/stream/attach.test.ts
git commit -m "feat(cli): attach helper wires logger events to a StreamRenderer"
```

---

### Task 13: CLI args — `--silent`, `--format`, `--no-color`

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `test/cli/args.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/cli/args.test.ts` inside the `describe("parseArgs")` block:

```ts
test("accepts --silent as a bareword flag on run", () => {
  const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x", "--silent"]);
  if (args.command !== "run") throw new Error("unreachable");
  expect(args.silent).toBe(true);
});

test("accepts --format pretty", () => {
  const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x", "--format", "pretty"]);
  if (args.command !== "run") throw new Error("unreachable");
  expect(args.format).toBe("pretty");
});

test("accepts --format jsonl", () => {
  const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x", "--format", "jsonl"]);
  if (args.command !== "run") throw new Error("unreachable");
  expect(args.format).toBe("jsonl");
});

test("rejects --format garbage", () => {
  expect(() => parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x", "--format", "nope"]))
    .toThrow(/Invalid --format/);
});

test("accepts --no-color as a bareword flag", () => {
  const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x", "--no-color"]);
  if (args.command !== "run") throw new Error("unreachable");
  expect(args.noColor).toBe(true);
});

test("leaves silent/format/noColor undefined or false when omitted", () => {
  const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "x"]);
  if (args.command !== "run") throw new Error("unreachable");
  expect(args.silent).toBe(false);
  expect(args.format).toBeUndefined();
  expect(args.noColor).toBe(false);
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test test/cli/args.test.ts`
Expected: the new cases fail (properties don't exist, or flags rejected as unknown).

- [ ] **Step 3: Update `RunArgs` and `RUN_ALLOWED`**

Edit `src/cli/args.ts`:

1. Extend `RUN_ALLOWED`:

```ts
const RUN_ALLOWED = new Set([
  "target", "out", "adapter", "model", "chrome", "project-dir",
  "turns", "viewport", "save-screencast",
  "silent", "format", "no-color",
]);
```

2. Extend `RunArgs`:

```ts
export interface RunArgs {
  command: "run";
  scenarioPath: string;
  outDir?: string;
  adapter: AdapterType;
  silent: boolean;
  format: "pretty" | "jsonl" | undefined;
  noColor: boolean;
  cli: CliArgsInput;
}
```

3. In `parseRunArgs`, after the existing adapter block:

```ts
let format: "pretty" | "jsonl" | undefined;
if (flags.format !== undefined) {
  if (flags.format !== "pretty" && flags.format !== "jsonl") {
    throw new Error(`Invalid --format value "${flags.format}": must be "pretty" or "jsonl"`);
  }
  format = flags.format;
}

return {
  command: "run",
  scenarioPath: positional,
  outDir: flags.out,
  adapter,
  silent: flags.silent === "true",
  format,
  noColor: flags["no-color"] === "true",
  cli: {
    // ...existing fields unchanged...
  },
};
```

4. Update `usage()` text — replace the `run` section with:

```
  run <scenario.md>    Run a scenario
    --target <url>       (required) Application under test
    --model agent=<name> Model for the agent (default: claude-sonnet-4-6)
    --chrome host:port   Chrome debugging endpoint (default: 127.0.0.1:9222)
    --adapter <type>     web | cli | tui (default: web)
    --turns <n>          Max agent turns for this run (default: 50)
    --viewport WxH       Browser viewport (default: 1440x900)
    --save-screencast    Persist screencast frames to disk (default: off; live WS stream is always on)
    --out <dir>          Evidence output directory (default: <project>/.gauntlet/results/<runId>)
    --project-dir <dir>  Project root (contains .gauntlet/ state dir)
    --silent             Suppress the streaming transcript (default: stream)
    --format <mode>      Stream format: pretty | jsonl (default: auto by TTY)
    --no-color           Disable ANSI color (also respects NO_COLOR env var)
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test test/cli/args.test.ts`
Expected: all cases pass, including pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts test/cli/args.test.ts
git commit -m "feat(cli): add --silent, --format, --no-color to run"
```

---

### Task 14: Wire into `src/cli/run.ts` + manual smoke

**Files:**
- Modify: `src/cli/run.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Thread new flags through `src/index.ts`**

In `src/index.ts`, the `case "run"` block currently passes a fixed set of fields to `run(...)`. Extend the call site:

```ts
case "run": {
  const config = await loadConfigOrExit(args.cli);
  await requireLlmCapableOrExit(config);
  await run({
    scenarioPath: args.scenarioPath,
    target: args.cli.target ?? "",
    outDir: args.outDir,
    adapterType: args.adapter,
    config,
    silent: args.silent,
    format: args.format,
    noColor: args.noColor,
  });
  break;
}
```

- [ ] **Step 2: Update `RunCommandOptions` and wire attachment**

Edit `src/cli/run.ts`:

```ts
import { resolveStreamOptions } from "./stream/format";
import { attachRenderer } from "./stream/attach";

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
```

Inside `run()`, after `const logger = new EvidenceLogger(outDir);`:

```ts
const streamOpts = resolveStreamOptions({
  isTTY: Boolean(process.stdout.isTTY),
  env: process.env as Record<string, string | undefined>,
  silent: opts.silent,
  format: opts.format,
  noColor: opts.noColor,
  columns: process.stdout.columns ?? 100,
});
const sink = { write: (s: string) => process.stdout.write(s) };
const detachStream = attachRenderer(logger, streamOpts, sink);
```

Wrap the existing `try { runAgent(...) ... } finally { adapter.close(); }` to:

1. Remove the unconditional `console.log(JSON.stringify(result, null, 2))` — replace with a silent-mode branch that still prints the JSON, preserving the old scripting contract ONLY under `--silent`:

```ts
try {
  const result = await runAgent(card, adapter, client, logger, target, {
    contextTree,
    runId,
    maxTurns: config.defaultTurns,
    provider: resolveProvider(config.models.agent),
    model: config.models.agent,
  });
  result.config = runConfig;
  writeResultFiles(outDir, result);
  if (streamOpts.silent) {
    // Silent: stderr line same as before, no stdout output.
    console.error(`runId: ${runId}`);
  } else {
    // Streaming: run_end panel is already printed via the renderer;
    // keep the stderr runId line off, since the panel contains it.
  }
} catch (err) {
  logger.logEvent("run_error", {
    turn: -1,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  throw err;
} finally {
  detachStream();
  await adapter.close();
}
```

Note: today's code prints the JSON via `console.log(JSON.stringify(result, null, 2))`. That line is removed entirely. The full `result.json` file on disk (written by `writeResultFiles`) is unchanged.

- [ ] **Step 3: Manual smoke — pretty mode**

Use any scenario file under `.gauntlet/stories/` (list with `ls .gauntlet/stories/`). Set `STORY` accordingly:

```bash
STORY=$(ls .gauntlet/stories/*.md | head -1)
bun src/index.ts run "$STORY" --target https://news.ycombinator.com --adapter cli
```

Expected output (to stdout, colored, paced live):
- A framed configured-values header.
- Turn headers as the agent takes turns.
- Tool call / result lines with timings.
- A `Run complete` (or `Run failed`) summary panel at end.
- No raw JSON dump.

- [ ] **Step 4: Manual smoke — silent mode**

```bash
bun src/index.ts run "$STORY" --target https://news.ycombinator.com --adapter cli --silent 1>/dev/null 2>stderr.txt
cat stderr.txt
```

Expected: `stderr.txt` contains exactly `runId: r-...` on a single line.

- [ ] **Step 5: Manual smoke — jsonl mode (piped)**

```bash
bun src/index.ts run "$STORY" --target https://news.ycombinator.com --adapter cli | jq -r '.type' | head -5
```

Expected: the first five event types, e.g. `run_start`, `system_prompt`, `user_message`, `llm_request`, `llm_response`.

- [ ] **Step 6: Run full test suite**

Run: `bun run check`
Expected: typecheck + UI typecheck + UI build + all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/cli/run.ts src/index.ts
git commit -m "feat(cli): wire streaming transcript into gauntlet run"
```

---

## Verification checklist (post-implementation)

Run these with the final code in place — each should behave as described.

- [ ] `gauntlet run X --target Y` in a terminal shows a live colored transcript.
- [ ] `gauntlet run X --target Y | cat` produces JSONL (`\{"eventId":...}` per line).
- [ ] `gauntlet run X --target Y --silent` emits nothing on stdout, `runId: ...` on stderr.
- [ ] `gauntlet run X --target Y --format jsonl` on a TTY still outputs JSONL.
- [ ] `gauntlet run X --target Y --no-color` emits pretty output without ANSI escapes.
- [ ] `NO_COLOR=1 gauntlet run X --target Y` emits pretty without ANSI.
- [ ] An LLM API failure produces the red `Run failed` panel in pretty mode and the CLI exits non-zero.
- [ ] A failing tool call shows the `✗ Nms` + `╵ error` + optional `╵ hint` lines.
- [ ] `run.jsonl` on disk remains byte-identical between streaming and `--silent` runs.
- [ ] `bun run check` passes.
