# Expanded run.jsonl — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `run.jsonl` from a thin per-tool-call log into a near-complete transcript (system prompt, user messages, model thinking/text, tool calls and their results, artifacts, run framing) — structured so a Phase 2 session can add replay/resume without schema changes.

**Architecture:** `EvidenceLogger` gains typed event emitters (`logRunStart`, `logSystemPrompt`, `logUserMessage`, `logLlmRequest`, `logLlmResponse`, `logToolCall`, `logToolResult`, `logEvent`, `logRunEnd`) plus `saveArtifact`. Every event carries a monotonic per-run `eventId` and a `parentEventId` pointing at the previous event (linear chain, matches `claude.jsonl`). The agent loop owns turn numbering and emits tool_call/tool_result (adapters no longer log tool invocations). Large document-like tool outputs spill to `artifacts/NNN.<ext>`; short narrative results stay inline. The old `{action, params}` row shape is removed (no external consumers).

**Tech Stack:** TypeScript, Bun test runner, Anthropic + OpenAI SDKs.

**Reference:** `docs/superpowers/specs/2026-04-21-expanded-run-log-design.md`

---

## File Structure

**Modified:**
- `src/evidence/logger.ts` — the event API lives here
- `src/agent/agent.ts` — emits the event stream
- `src/adapters/cli/adapter.ts` — drops `logAction(name, args)`; anomalies move to `logEvent`
- `src/adapters/tui/adapter.ts` — same
- `src/adapters/web/adapter.ts` — same; `extract` (full-page) routes through `saveArtifact`
- `src/adapters/web/passkey.ts` — migrate `logAction` → `logEvent`
- `src/types.ts` — `VetResult.evidence.artifacts?: string[]`
- `docs/format.md` — rewrite `run.jsonl` section

**Tests modified/added:**
- `test/evidence/logger.test.ts` — rewrite around new API
- `test/agent/event-stream.test.ts` — new; end-to-end event sequence assertions
- `test/adapters/tui/adapter.test.ts`, `test/adapters/web/*` — update log assertions

---

## Task 1: Logger — add event API alongside legacy `logAction`

Introduces the new event API without breaking existing callers. `logAction` becomes a thin alias to `logEvent` internally so adapters/agent keep compiling until migrated.

**Files:**
- Modify: `src/evidence/logger.ts`
- Modify: `test/evidence/logger.test.ts`

- [ ] **Step 1: Write failing tests for event-id chain**

Add to `test/evidence/logger.test.ts`, inside the existing `describe("EvidenceLogger", ...)`:

```ts
test("logRunStart writes the first event with eventId 1 and parentEventId 0", () => {
  logger.logRunStart({
    runId: "card-001_20260421T000000Z_aaaa",
    cardId: "card-001",
    target: "http://localhost:3000",
    provider: "anthropic",
    model: "claude-opus-4-7",
    adapter: "web",
    maxTurns: 50,
    toolTimeoutMs: 30000,
    contextTreeBytes: 0,
  });

  const [row] = readFileSync(join(outDir, "run.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  expect(row.type).toBe("run_start");
  expect(row.eventId).toBe(1);
  expect(row.parentEventId).toBe(0);
  expect(row.ts).toBeDefined();
  expect(row.runId).toBe("card-001_20260421T000000Z_aaaa");
  expect(row.cardId).toBe("card-001");
  expect(row.provider).toBe("anthropic");
  expect(row.maxTurns).toBe(50);
});

test("each subsequent event chains parentEventId to the previous eventId", () => {
  logger.logSystemPrompt("be helpful");
  logger.logUserMessage(0, "go");
  logger.logEvent("custom", { foo: 1 });

  const rows = readFileSync(join(outDir, "run.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  expect(rows.map((r) => r.eventId)).toEqual([1, 2, 3]);
  expect(rows.map((r) => r.parentEventId)).toEqual([0, 1, 2]);
  expect(rows.map((r) => r.type)).toEqual([
    "system_prompt",
    "user_message",
    "event",
  ]);
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `bun test test/evidence/logger.test.ts`
Expected: failures — `logger.logRunStart is not a function` etc.

- [ ] **Step 3: Rewrite `src/evidence/logger.ts`**

```ts
import { mkdirSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";

export type BrowserEventCategory =
  | "console"
  | "exception"
  | "log"
  | "network-ws";

export type ActionObserver = (
  action: string,
  params: Record<string, unknown>,
) => void;

export interface RunStartFields {
  runId: string;
  cardId: string;
  target: string | undefined;
  provider: string;
  model: string;
  adapter: string;
  maxTurns: number;
  toolTimeoutMs: number;
  contextTreeBytes: number;
}

export interface LlmResponseFields {
  turn: number;
  stopReason: string;
  text: string;
  thinking: Array<{ text: string; signature?: string }>;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  rawAssistantMessage: unknown;
}

export interface ToolResultFields {
  turn: number;
  toolUseId: string;
  name: string;
  durationMs: number;
  text: string;
  image?: string;            // relative path
  artifact?: string;         // relative path
  textTruncated?: true;
  textBytes?: number;
  error: boolean;
}

export interface RunEndFields {
  status: string;
  summary: string;
  reasoning: string;
  observationCount: number;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    turns: number;
  };
}

const INLINE_TEXT_LIMIT = 32 * 1024;

export class EvidenceLogger {
  private outDir: string;
  private screenshotCount = 0;
  private artifactCount = 0;
  private _screenshots: string[] = [];
  private _artifacts: string[] = [];
  private observers: Set<ActionObserver> = new Set();
  private eventCounter = 0;
  private lastEventId = 0;

  constructor(outDir: string) {
    this.outDir = outDir;
    mkdirSync(join(outDir, "screenshots"), { recursive: true });
    mkdirSync(join(outDir, "artifacts"), { recursive: true });
  }

  get screenshots(): string[] { return [...this._screenshots]; }
  get artifacts(): string[] { return [...this._artifacts]; }
  get logPath(): string { return "run.jsonl"; }

  addObserver(fn: ActionObserver): () => void {
    this.observers.add(fn);
    return () => { this.observers.delete(fn); };
  }

  private notifyObservers(action: string, params: Record<string, unknown>): void {
    for (const fn of this.observers) {
      try { fn(action, params); } catch { /* isolated */ }
    }
  }

  private writeEvent(type: string, body: Record<string, unknown>): number {
    this.eventCounter += 1;
    const eventId = this.eventCounter;
    const entry = {
      eventId,
      parentEventId: this.lastEventId,
      ts: new Date().toISOString(),
      type,
      ...body,
    };
    appendFileSync(join(this.outDir, "run.jsonl"), JSON.stringify(entry) + "\n");
    this.lastEventId = eventId;
    return eventId;
  }

  logRunStart(fields: RunStartFields): void {
    this.writeEvent("run_start", { ...fields });
  }

  logSystemPrompt(content: string): void {
    this.writeEvent("system_prompt", { content });
  }

  logUserMessage(turn: number, content: string): void {
    this.writeEvent("user_message", { turn, content });
  }

  logLlmRequest(turn: number, messageCount: number): void {
    this.writeEvent("llm_request", { turn, messageCount });
  }

  logLlmResponse(fields: LlmResponseFields): void {
    this.writeEvent("llm_response", { ...fields });
  }

  logToolCall(fields: {
    turn: number;
    toolUseId: string;
    name: string;
    arguments: Record<string, unknown>;
  }): void {
    this.writeEvent("tool_call", { ...fields });
  }

  logToolResult(fields: ToolResultFields): void {
    let body: Record<string, unknown> = { ...fields };
    if (typeof fields.text === "string" && Buffer.byteLength(fields.text, "utf8") > INLINE_TEXT_LIMIT) {
      const bytes = Buffer.byteLength(fields.text, "utf8");
      const spilled = this.saveArtifact(fields.text, "txt");
      body = {
        ...body,
        text: `<spilled — see ${spilled}>`,
        textTruncated: true,
        textBytes: bytes,
        artifact: fields.artifact ?? spilled,
      };
      this.logEvent("tool_result_text_oversize", {
        turn: fields.turn,
        name: fields.name,
        bytes,
        artifact: spilled,
      });
    }
    this.writeEvent("tool_result", body);
  }

  logEvent(name: string, data: Record<string, unknown>): void {
    this.writeEvent("event", { name, ...data });
    this.notifyObservers(name, data);
  }

  logRunEnd(fields: RunEndFields): void {
    this.writeEvent("run_end", { ...fields });
  }

  logAction(action: string, params: Record<string, unknown>): void {
    this.logEvent(action, params);
  }

  logBrowserEvent(
    category: BrowserEventCategory,
    data: Record<string, unknown>,
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      category,
      ...data,
    };
    appendFileSync(
      join(this.outDir, `${category}.jsonl`),
      JSON.stringify(entry) + "\n",
    );
  }

  saveScreenshot(data: Buffer, name?: string): string {
    if (!name) {
      this.screenshotCount++;
      name = String(this.screenshotCount).padStart(3, "0");
    }
    const relativePath = `screenshots/${name}.png`;
    writeFileSync(join(this.outDir, relativePath), data);
    this._screenshots.push(relativePath);
    return relativePath;
  }

  saveArtifact(data: Buffer | string, ext: string): string {
    this.artifactCount++;
    const name = String(this.artifactCount).padStart(3, "0");
    const relativePath = `artifacts/${name}.${ext}`;
    writeFileSync(join(this.outDir, relativePath), data);
    this._artifacts.push(relativePath);
    return relativePath;
  }
}
```

- [ ] **Step 4: Update the legacy observer test expectations**

The existing observer tests expect observers to fire on `logAction`. Since `logAction` now calls `logEvent` which calls `notifyObservers`, they still pass semantically. Verify by re-reading them — no changes needed.

Remove the `test("logs actions to run.jsonl", ...)` block (lines 24-38 of the existing file) — it asserts the old `{action, params, timestamp}` shape which no longer exists.

Replace its assertion style with this replacement test (add near the new tests):

```ts
test("logAction emits an event row with the action as the name", () => {
  logger.logAction("navigate", { url: "http://localhost:3000" });

  const [row] = readFileSync(join(outDir, "run.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  expect(row.type).toBe("event");
  expect(row.name).toBe("navigate");
  expect(row.url).toBe("http://localhost:3000");
});
```

- [ ] **Step 5: Run tests, confirm they pass**

Run: `bun test test/evidence/logger.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/evidence/logger.ts test/evidence/logger.test.ts
git commit -m "evidence: add typed event emitters + saveArtifact

EvidenceLogger gains logRunStart / logSystemPrompt / logUserMessage /
logLlmRequest / logLlmResponse / logToolCall / logToolResult / logEvent /
logRunEnd, each emitting a row with eventId + parentEventId (linear
chain). saveArtifact spills buffers to artifacts/NNN.<ext>. logAction
becomes an alias for logEvent so existing callers keep compiling; it
will be removed once migrations land.

Co-Authored-By: Boswell (Bob 4385f13d/Opus 4.7)"
```

---

## Task 2: Artifact tracking in `VetResult`

The results manifest should list artifacts so the HTTP file route allows fetching them.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/agent/agent.ts` (only the `evidence` object inside `buildResult`)
- Modify: `test/api/results.test.ts`, `test/api/fanout.test.ts`, `test/api/file-route.test.ts`, `test/evidence/writer.test.ts` — fixture objects can stay as-is (artifacts is optional); no test changes required unless a test wants to assert it

- [ ] **Step 1: Add field to the type**

Find the `VetResult` type in `src/types.ts`. Inside its `evidence` object, add:

```ts
artifacts?: string[];
```

- [ ] **Step 2: Populate the field in `agent.ts`**

In `src/agent/agent.ts`, inside the `buildResult` helper, change the `evidence` object:

```ts
evidence: {
  screenshots: logger.screenshots,
  log: logger.logPath,
  artifacts: logger.artifacts.length > 0 ? logger.artifacts : undefined,
},
```

- [ ] **Step 3: Verify type-check and existing tests**

Run: `bun run tsc --noEmit 2>&1 | head -30` (expect clean)
Run: `bun test` — existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/agent/agent.ts
git commit -m "evidence: surface artifacts[] in VetResult manifest

Co-Authored-By: Boswell (Bob 4385f13d/Opus 4.7)"
```

---

## Task 3: Agent — emit `run_start`, `system_prompt`, initial `user_message`

**Files:**
- Modify: `src/agent/agent.ts`
- Create: `test/agent/event-stream.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/agent/event-stream.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EvidenceLogger } from "../../src/evidence/logger";
import { runAgent } from "../../src/agent/agent";
import type { LLMClient, AgentResponse, ToolCall, ToolResult } from "../../src/models/provider";
import type { Adapter } from "../../src/adapters/adapter";
import type { StoryCard } from "../../src/format/story-card";

function readLog(outDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(outDir, "run.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function makeCard(): StoryCard {
  return {
    id: "card-001",
    title: "t",
    goal: "g",
    steps: ["s"],
    pass: "p",
    fail: "f",
  } as unknown as StoryCard;
}

function makeAdapter(): Adapter {
  return {
    name: "test",
    toolDefinitions: () => [],
    async executeTool(_n, _a, _l): Promise<ToolResult> { return { text: "ok" }; },
    async start() {}, async close() {},
  } as unknown as Adapter;
}

function makeClient(responses: AgentResponse[]): LLMClient {
  let i = 0;
  return {
    async chat() { return responses[i++]; },
    userMessage(content: string) { return { role: "user", content }; },
    toolResultMessages(calls: ToolCall[], results: ToolResult[]) {
      return [{ role: "user", content: calls.map((c, j) => ({ tool_use_id: c.id, text: results[j].text })) }];
    },
  };
}

describe("agent event stream", () => {
  let outDir: string;
  let logger: EvidenceLogger;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "gauntlet-agent-"));
    logger = new EvidenceLogger(outDir);
  });
  afterEach(() => rmSync(outDir, { recursive: true, force: true }));

  test("emits run_start, system_prompt, user_message as first three rows", async () => {
    const client = makeClient([{
      text: "", toolCalls: [{ id: "t1", name: "report_result", arguments: { status: "pass", summary: "s", reasoning: "r" } }],
      stopReason: "tool_use", rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 10, outputTokens: 5 },
    }]);
    await runAgent(makeCard(), makeAdapter(), client, logger, "http://x", {
      runId: "card-001_20260421T000000Z_aaaa",
    });

    const rows = readLog(outDir);
    expect(rows[0].type).toBe("run_start");
    expect(rows[0].runId).toBe("card-001_20260421T000000Z_aaaa");
    expect(rows[0].cardId).toBe("card-001");
    expect(rows[1].type).toBe("system_prompt");
    expect(typeof rows[1].content).toBe("string");
    expect(rows[2].type).toBe("user_message");
    expect(rows[2].turn).toBe(0);
    expect((rows[2].content as string)).toContain("http://x");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/agent/event-stream.test.ts`
Expected: FAIL (first row is not `run_start`).

- [ ] **Step 3: Emit the events**

In `src/agent/agent.ts`, inside `runAgent`, after the `const tools = ...` line but before the initial-message construction, insert:

```ts
logger.logRunStart({
  runId,
  cardId: card.id,
  target,
  provider: "unknown",      // providers don't currently self-identify; set by caller in a later refinement
  model: "unknown",
  adapter: adapter.name ?? "unknown",
  maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
  toolTimeoutMs: options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
  contextTreeBytes: options.contextTree ? Buffer.byteLength(options.contextTree, "utf8") : 0,
});
logger.logSystemPrompt(systemPrompt);
logger.logUserMessage(0, initialMessage);
```

Note: `provider` and `model` are `"unknown"` here because `runAgent` doesn't receive them today. Task 8 plumbs them through.

- [ ] **Step 4: Re-run test, verify it passes**

Run: `bun test test/agent/event-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.ts test/agent/event-stream.test.ts
git commit -m "agent: emit run_start / system_prompt / user_message

Co-Authored-By: Boswell (Bob 4385f13d/Opus 4.7)"
```

---

## Task 4: Agent — emit `llm_request` + `llm_response` per turn

**Files:**
- Modify: `src/agent/agent.ts`
- Modify: `test/agent/event-stream.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/agent/event-stream.test.ts`:

```ts
test("emits llm_request + llm_response per turn with usage and rawAssistantMessage", async () => {
  const rawAssistant = { role: "assistant", content: [{ type: "text", text: "hi" }] };
  const client = makeClient([{
    text: "hi",
    toolCalls: [{ id: "t1", name: "report_result", arguments: { status: "pass", summary: "s", reasoning: "r" } }],
    stopReason: "tool_use",
    rawAssistantMessage: rawAssistant,
    usage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 50, cacheReadInputTokens: 30 },
  }]);

  await runAgent(makeCard(), makeAdapter(), client, logger, undefined, {
    runId: "card-001_20260421T000000Z_aaaa",
  });

  const rows = readLog(outDir);
  const req = rows.find((r) => r.type === "llm_request");
  const res = rows.find((r) => r.type === "llm_response");
  expect(req).toBeDefined();
  expect(req!.turn).toBe(1);
  expect(req!.messageCount).toBe(1);
  expect(res).toBeDefined();
  expect(res!.turn).toBe(1);
  expect(res!.stopReason).toBe("tool_use");
  expect(res!.text).toBe("hi");
  expect((res!.usage as any).inputTokens).toBe(100);
  expect((res!.usage as any).cacheReadInputTokens).toBe(30);
  expect(res!.rawAssistantMessage).toEqual(rawAssistant);
  expect(Array.isArray(res!.toolCalls)).toBe(true);
  expect((res!.toolCalls as any[])[0].name).toBe("report_result");
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/agent/event-stream.test.ts -t "llm_request"`
Expected: FAIL (no `llm_request` row).

- [ ] **Step 3: Emit the events**

In `src/agent/agent.ts`, inside the `for (let turn = 0; turn < maxTurns; turn++)` loop, before `const response = await client.chat(...)`, insert:

```ts
logger.logLlmRequest(turns + 1, messages.length);
```

After `turns++;` (so turn number matches the emitted `llm_request`), insert:

```ts
const thinkingBlocks: Array<{ text: string; signature?: string }> = [];
const raw = response.rawAssistantMessage as { content?: Array<Record<string, unknown>> } | undefined;
if (raw && Array.isArray(raw.content)) {
  for (const block of raw.content) {
    if (block && block.type === "thinking" && typeof block.thinking === "string") {
      thinkingBlocks.push({
        text: block.thinking as string,
        signature: typeof block.signature === "string" ? block.signature : undefined,
      });
    }
  }
}

logger.logLlmResponse({
  turn: turns,
  stopReason: response.stopReason,
  text: response.text,
  thinking: thinkingBlocks,
  toolCalls: response.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
  usage: {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
    cacheReadInputTokens: response.usage.cacheReadInputTokens,
  },
  rawAssistantMessage: response.rawAssistantMessage,
});
```

- [ ] **Step 4: Re-run test, verify it passes**

Run: `bun test test/agent/event-stream.test.ts -t "llm_request"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.ts test/agent/event-stream.test.ts
git commit -m "agent: emit llm_request + llm_response per turn

Captures stop reason, text, thinking blocks (with signatures),
structured tool calls, per-turn usage, and the raw assistant message
verbatim for replay fidelity.

Co-Authored-By: Boswell (Bob 4385f13d/Opus 4.7)"
```

---

## Task 5: Agent — emit `tool_call` + `tool_result`; migrate anomalies; emit `run_end`

**Files:**
- Modify: `src/agent/agent.ts`
- Modify: `test/agent/event-stream.test.ts`

- [ ] **Step 1: Write failing tests**

Add:

```ts
test("emits tool_call + tool_result around each tool execution", async () => {
  const client = makeClient([
    {
      text: "", toolCalls: [{ id: "t1", name: "noop", arguments: { a: 1 } }],
      stopReason: "tool_use",
      rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "", toolCalls: [{ id: "t2", name: "report_result", arguments: { status: "pass", summary: "s", reasoning: "r" } }],
      stopReason: "tool_use",
      rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);

  const adapter = {
    name: "test",
    toolDefinitions: () => [{ name: "noop", description: "", parameters: { type: "object", properties: {} } }],
    async executeTool() { return { text: "done" }; },
    async start() {}, async close() {},
  } as unknown as Adapter;

  await runAgent(makeCard(), adapter, client, logger, undefined, {
    runId: "card-001_20260421T000000Z_aaaa",
  });

  const rows = readLog(outDir);
  const call = rows.find((r) => r.type === "tool_call" && r.name === "noop");
  const result = rows.find((r) => r.type === "tool_result" && r.name === "noop");
  expect(call).toBeDefined();
  expect(call!.toolUseId).toBe("t1");
  expect(call!.turn).toBe(1);
  expect((call!.arguments as any).a).toBe(1);
  expect(result).toBeDefined();
  expect(result!.toolUseId).toBe("t1");
  expect(result!.text).toBe("done");
  expect(result!.error).toBe(false);
  expect(typeof result!.durationMs).toBe("number");
});

test("tool failure surfaces error:true and the message in text", async () => {
  const client = makeClient([
    {
      text: "", toolCalls: [{ id: "t1", name: "noop", arguments: {} }],
      stopReason: "tool_use",
      rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "", toolCalls: [{ id: "t2", name: "report_result", arguments: { status: "investigate", summary: "s", reasoning: "r" } }],
      stopReason: "tool_use",
      rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  const adapter = {
    name: "test",
    toolDefinitions: () => [{ name: "noop", description: "", parameters: { type: "object", properties: {} } }],
    async executeTool() { throw new Error("boom"); },
    async start() {}, async close() {},
  } as unknown as Adapter;

  await runAgent(makeCard(), adapter, client, logger, undefined, {
    runId: "card-001_20260421T000000Z_aaaa",
  });

  const result = readLog(outDir).find((r) => r.type === "tool_result");
  expect(result!.error).toBe(true);
  expect((result!.text as string)).toContain("boom");
});

test("emits run_end as the last event, with usage totals and status", async () => {
  const client = makeClient([{
    text: "", toolCalls: [{ id: "t1", name: "report_result", arguments: { status: "pass", summary: "ok", reasoning: "r" } }],
    stopReason: "tool_use", rawAssistantMessage: { role: "assistant", content: [] },
    usage: { inputTokens: 10, outputTokens: 5 },
  }]);
  await runAgent(makeCard(), makeAdapter(), client, logger, undefined, {
    runId: "card-001_20260421T000000Z_aaaa",
  });

  const rows = readLog(outDir);
  const last = rows[rows.length - 1];
  expect(last.type).toBe("run_end");
  expect(last.status).toBe("pass");
  expect(last.summary).toBe("ok");
  expect((last.usage as any).inputTokens).toBe(10);
  expect((last.usage as any).turns).toBe(1);
});
```

- [ ] **Step 2: Run, verify failures**

Run: `bun test test/agent/event-stream.test.ts`
Expected: the three new tests FAIL.

- [ ] **Step 3: Emit tool_call / tool_result / run_end**

In `src/agent/agent.ts`:

(a) Inside the tool-execution block (`if (response.toolCalls.length > 0)`), replace the inner `for (const tc of response.toolCalls)` loop with:

```ts
for (const tc of response.toolCalls) {
  logger.logToolCall({ turn: turns, toolUseId: tc.id, name: tc.name, arguments: tc.arguments });
  const started = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let result: ToolResult;
  let errored = false;
  try {
    result = await Promise.race([
      adapter.executeTool(tc.name, tc.arguments, logger),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Tool "${tc.name}" timed out after ${toolTimeout}ms`)),
          toolTimeout,
        );
      }),
    ]);
  } catch (error) {
    errored = true;
    const message = error instanceof Error ? error.message : String(error);
    result = { text: `Error: ${message}` };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  results.push(result);
  logger.logToolResult({
    turn: turns,
    toolUseId: tc.id,
    name: tc.name,
    durationMs: Date.now() - started,
    text: result.text ?? "",
    image: result.imagePath,          // populated by adapters that save images (Task 6)
    artifact: result.artifactPath,    // populated when adapter spills (Task 7)
    error: errored,
  });
}
```

(The fields `imagePath` / `artifactPath` on `ToolResult` are added in Tasks 6/7. For now they'll be `undefined` and the row will simply omit them — that's fine.)

(b) Migrate anomaly calls: change `logger.logAction("report_with_other_tools_dropped", ...)`, `logger.logAction("stopped_max_tokens", ...)`, `logger.logAction("empty_response", ...)` → `logger.logEvent(...)` with the same args. Three one-line edits.

(c) Emit `run_end` inside `buildResult`. Change `buildResult` to:

```ts
const buildResult = (partial: {
  status: VetStatus;
  summary: string;
  reasoning: string;
  observations?: VetResult["observations"];
}): VetResult => {
  const result: VetResult = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    runId,
    scenario: card.id,
    status: partial.status,
    summary: partial.summary,
    reasoning: partial.reasoning,
    observations: partial.observations ?? [],
    evidence: {
      screenshots: logger.screenshots,
      log: logger.logPath,
      artifacts: logger.artifacts.length > 0 ? logger.artifacts : undefined,
    },
    duration_ms: Date.now() - startTime,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheCreationInputTokens: totalCacheCreation > 0 ? totalCacheCreation : undefined,
      cacheReadInputTokens: totalCacheRead > 0 ? totalCacheRead : undefined,
      turns,
    },
  };
  logger.logRunEnd({
    status: result.status,
    summary: result.summary,
    reasoning: result.reasoning,
    observationCount: result.observations.length,
    durationMs: result.duration_ms,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
      cacheReadInputTokens: result.usage.cacheReadInputTokens,
      turns: result.usage.turns,
    },
  });
  return result;
};
```

- [ ] **Step 4: Re-run tests, verify pass**

Run: `bun test test/agent/event-stream.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.ts test/agent/event-stream.test.ts
git commit -m "agent: emit tool_call / tool_result / run_end; anomalies → logEvent

Agent loop now owns tool invocation logging (adapters will drop their
logAction call in the next step). Tool errors surface as error:true on
the tool_result row. Anomalies (report_with_other_tools_dropped,
stopped_max_tokens, empty_response) move from logAction to logEvent.
run_end is emitted from the buildResult helper so every terminal path
writes one.

Co-Authored-By: Boswell (Bob 4385f13d/Opus 4.7)"
```

---

## Task 6: Adapters — drop `logAction(name, args)`; migrate anomalies; pass image paths

**Files:**
- Modify: `src/adapters/cli/adapter.ts`
- Modify: `src/adapters/tui/adapter.ts`
- Modify: `src/adapters/web/adapter.ts`
- Modify: `src/adapters/web/passkey.ts`
- Modify: `src/models/provider.ts` — add `imagePath?: string`, `artifactPath?: string` to `ToolResult`
- Modify: `test/adapters/tui/adapter.test.ts`

- [ ] **Step 1: Extend ToolResult**

In `src/models/provider.ts`, change the `ToolResult` interface to:

```ts
export interface ToolResult {
  text: string;
  image?: {
    data: string;       // base64-encoded
    mediaType: string;  // e.g. "image/png"
  };
  imagePath?: string;       // relative path if the image has been persisted
  artifactPath?: string;    // relative path if a large payload was spilled
}
```

- [ ] **Step 2: CLI adapter**

In `src/adapters/cli/adapter.ts` line 136, delete:

```ts
logger.logAction(name, args);
```

- [ ] **Step 3: TUI adapter**

In `src/adapters/tui/adapter.ts` line 184, delete:

```ts
logger.logAction(name, args);
```

- [ ] **Step 4: Web adapter — drop the action row and migrate anomalies**

In `src/adapters/web/adapter.ts`:

- Line 571 inside `executeTool`: delete `logger.logAction(name, args);`
- Line 127: change `this.logger?.logAction("set_viewport_failed", ...)` → `this.logger?.logEvent("set_viewport_failed", ...)` (same args object).
- Line 162: change `logger.logAction("observer_session_failed", ...)` → `logger.logEvent("observer_session_failed", ...)`.
- Line 197: change `this.logger?.logAction("chrome_profile_cleanup_failed", ...)` → `this.logger?.logEvent("chrome_profile_cleanup_failed", ...)`.

In the web adapter's screenshot-returning tool paths, when `takeReturnScreenshot()` or the explicit `screenshot` tool produces an image, call `logger.saveScreenshot(...)` (if not already) and set `imagePath` on the returned ToolResult. Concretely, grep for `return { text: ..., image: ...` results and, wherever the image is available as a Buffer, do:

```ts
const imagePath = logger.saveScreenshot(buf);
return { text: "...", image: { data: buf.toString("base64"), mediaType: "image/png" }, imagePath };
```

(The existing `screenshot` tool already calls `saveScreenshot`; just pass the returned path through.)

- [ ] **Step 5: Passkey**

In `src/adapters/web/passkey.ts`, change each `logger?.logAction("install_passkey_failed" | "install_passkey_ok", ...)` to `logger?.logEvent(...)`. Four sites (lines 188, 201, 212, 235, 243).

- [ ] **Step 6: Fix the TUI adapter test**

Open `test/adapters/tui/adapter.test.ts`. The test currently reads `run.jsonl` and expects old-shape rows. Update its assertions to the new event shape. Replace the log-reading assertion with:

```ts
const rows = readFileSync(join(logDir, "run.jsonl"), "utf-8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
// Adapter no longer writes a row per tool invocation — that's the agent's job.
// Tool invocations here run *without* the agent, so run.jsonl should be empty
// or contain only adapter-emitted events (none in the happy path).
expect(rows.filter((r) => r.type === "tool_call")).toEqual([]);
```

(Adjust the exact expectation to match whatever the test was previously asserting; the principle is: tool invocations are no longer adapter-emitted.)

- [ ] **Step 7: Run the full test suite**

Run: `bun test`
Expected: all pass. Fix any remaining fixture drift by the same principle (old `{action, params}` rows no longer exist — update assertions to the new event shape or remove assertions that duplicate what the logger test now covers).

- [ ] **Step 8: Commit**

```bash
git add src/models/provider.ts src/adapters/ test/adapters/
git commit -m "adapters: drop per-tool logAction; anomalies use logEvent

The agent loop now owns tool_call/tool_result rows. Adapters keep their
anomaly reporting but migrate to logger.logEvent. ToolResult gains
imagePath/artifactPath so agents can reference persisted files in the
transcript without re-embedding blobs.

Co-Authored-By: Boswell (Bob 4385f13d/Opus 4.7)"
```

---

## Task 7: Web `extract` (no selector) → `saveArtifact`

The full-page markdown extract is the largest predictable payload and benefits most from spilling.

**Files:**
- Modify: `src/adapters/web/adapter.ts` (the `case "extract":` block around line 761)
- Modify: `test/adapters/web/*` (whichever file covers the extract tool) — add a test

- [ ] **Step 1: Write failing test**

Find the test file that currently exercises `extract`. If none, create `test/adapters/web/extract.test.ts` — use the pattern of existing adapter tests in the repo. The test should:
- Stub `chrome.generateMarkdown` to return a big string (`"x".repeat(50_000)`).
- Call the adapter's `executeTool("extract", {}, logger)`.
- Assert that the returned `ToolResult.artifactPath` matches `/^artifacts\/\d+\.md$/`, that `text` is a short summary (e.g. `"Full-page extract spilled to ..."`), and that the artifact file contains the full 50 KB.

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test <path-to-new-test>`
Expected: FAIL.

- [ ] **Step 3: Route no-selector extract through saveArtifact**

Replace the no-selector branch of `case "extract":` in `src/adapters/web/adapter.ts`:

```ts
case "extract": {
  const selector = args.selector as string | undefined;
  if (selector) {
    const text = await chrome.extractText(0, selector);
    return { text };
  }
  const markdown = await chrome.generateMarkdown(0);
  const path = logger.saveArtifact(markdown, "md");
  const bytes = Buffer.byteLength(markdown, "utf8");
  return {
    text: `Full-page extract spilled to ${path} (${bytes} bytes).`,
    artifactPath: path,
  };
}
```

- [ ] **Step 4: Re-run test, verify pass**

Run: `bun test <path-to-new-test>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/web/adapter.ts test/adapters/web/
git commit -m "web: spill full-page extract markdown to artifacts/

Keeps run.jsonl readable top-to-bottom; the model still sees the path
and byte count in its tool_result text.

Co-Authored-By: Boswell (Bob 4385f13d/Opus 4.7)"
```

---

## Task 8: Thread provider + model into `run_start`

The `run_start` row should carry real `provider` and `model` strings rather than `"unknown"`.

**Files:**
- Modify: `src/agent/agent.ts` — add optional `provider` / `model` to `AgentOptions`; use them in `logRunStart`
- Modify: `src/cli/run.ts` and `src/api/routes/run.ts` — pass them through (they already know provider/model when constructing the client)

- [ ] **Step 1: Extend AgentOptions**

In `src/agent/agent.ts`:

```ts
export interface AgentOptions {
  toolTimeoutMs?: number;
  maxTurns?: number;
  contextTree?: string;
  runId: string;
  provider?: string;    // NEW — for the run_start log row
  model?: string;       // NEW
}
```

And in the `logger.logRunStart` call, use `options.provider ?? "unknown"` / `options.model ?? "unknown"`.

- [ ] **Step 2: Plumb from CLI runner**

In `src/cli/run.ts`, find where `runAgent(...)` is called. Inside the `options` object, add:

```ts
provider: resolved.provider,
model: resolved.model,
```

Match whatever variable holds the resolved provider/model for this run — check `src/models/resolve.ts` if unclear.

- [ ] **Step 3: Plumb from API runner**

Same edit inside `src/api/routes/run.ts` at the `runAgent(...)` call.

- [ ] **Step 4: Update the event-stream test**

In `test/agent/event-stream.test.ts`, add a test:

```ts
test("run_start carries provider + model when supplied", async () => {
  const client = makeClient([{
    text: "", toolCalls: [{ id: "t1", name: "report_result", arguments: { status: "pass", summary: "s", reasoning: "r" } }],
    stopReason: "tool_use", rawAssistantMessage: { role: "assistant", content: [] },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  await runAgent(makeCard(), makeAdapter(), client, logger, undefined, {
    runId: "card-001_20260421T000000Z_aaaa",
    provider: "anthropic",
    model: "claude-opus-4-7",
  });
  const start = readLog(outDir).find((r) => r.type === "run_start")!;
  expect(start.provider).toBe("anthropic");
  expect(start.model).toBe("claude-opus-4-7");
});
```

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/agent/agent.ts src/cli/run.ts src/api/routes/run.ts test/agent/event-stream.test.ts
git commit -m "agent: thread provider + model into run_start

Co-Authored-By: Boswell (Bob 4385f13d/Opus 4.7)"
```

---

## Task 9: Remove the `logAction` alias; update `docs/format.md`

Final cleanup: no callers of `logAction` remain.

**Files:**
- Modify: `src/evidence/logger.ts` — remove `logAction` and its test
- Modify: `test/evidence/logger.test.ts` — remove tests that used `logAction` as input (observer tests can use `logEvent` instead)
- Modify: `docs/format.md`

- [ ] **Step 1: Verify no remaining callers**

Run: `grep -rn "logAction" src/ test/ | grep -v "logAction is"` (expect no hits other than the method definition and any remaining observer tests).

If any hits remain, migrate them to `logEvent` and re-run.

- [ ] **Step 2: Delete `logAction` from logger**

Remove the `logAction` method from `src/evidence/logger.ts`. Update any logger tests that exercised `logAction` to use `logEvent` instead — the behavior is identical.

- [ ] **Step 3: Rewrite `docs/format.md` run.jsonl section**

Replace the lines describing `run.jsonl` (around lines 10-16 and any "Append-only action log" mention) with:

```markdown
  run.jsonl          Append-only event stream — one JSON object per event.
                     Events include run_start, system_prompt, user_message,
                     llm_request, llm_response (with text, thinking blocks,
                     tool calls, usage, and the raw assistant message),
                     tool_call, tool_result (text inline, or image/artifact
                     relative paths), event (adapter/agent anomalies),
                     and run_end. Every event carries eventId + parentEventId
                     forming a linear chain.
  artifacts/         Document-like tool outputs spilled from tool_result rows
                     (DOM dumps, full-page extracts, large JSON, etc.)
```

Add (in the `evidence` manifest section) an `artifacts` bullet:

```
- `artifacts` (optional): relative paths to document-like tool outputs
  spilled from tool_result rows (DOM dumps, full-page extracts, etc.)
```

- [ ] **Step 4: Run full suite one more time**

Run: `bun test && bun run tsc --noEmit`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/evidence/logger.ts test/evidence/logger.test.ts docs/format.md
git commit -m "evidence: retire logAction alias; update format.md

All callers migrated to logEvent (anomalies) or the typed emitters
(agent loop). The run.jsonl format docs now describe the event stream.

Co-Authored-By: Boswell (Bob 4385f13d/Opus 4.7)"
```

---

## Self-Review

**Spec coverage:**
- `run_start` / `system_prompt` / `user_message` — Tasks 3, 8
- `llm_request` / `llm_response` with thinking + rawAssistantMessage — Task 4
- `tool_call` / `tool_result` with errors and timing — Task 5
- `run_end` — Task 5
- `event` for anomalies — Tasks 5, 6
- `saveArtifact` + 32KB safety net — Task 1
- Artifacts surfaced in `VetResult.evidence.artifacts` — Task 2
- Adapter cleanup — Task 6
- Web `extract` artifact flow — Task 7
- Docs — Task 9
- eventId + parentEventId chain — Task 1

**Placeholder scan:** no TBDs. Tool-signature names (`logToolCall`, `logToolResult`, `saveArtifact`, `imagePath`, `artifactPath`) are consistent across tasks.

**Type consistency:** `ToolResult.imagePath` / `artifactPath` introduced in Task 6 are first *referenced* in Task 5's `logToolResult` call (they'll be `undefined` at runtime until Task 6 lands — fine because the logger just omits undefined fields). Test in Task 5 doesn't assert image/artifact values, so ordering is safe.

**Ambiguity:** Task 6 Step 6 says "update assertions to match new event shape" — I've left concrete guidance (`rows.filter((r) => r.type === "tool_call")`) but the exact prior assertion in that test depends on its current content; the engineer needs to read it and adjust. Acceptable because the principle is clear.
