# Session revival (`gauntlet ask`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `gauntlet ask <runId> [--turn N] [--model MODEL]` — a CLI that reconstructs the agent state at turn N of a completed run and lets the operator chat with the model, writing nothing back.

**Architecture:** Two new event/field additions to `run.jsonl` (recording side). One new function `rebuildMessages(runDir, client, upToTurn?)` (reading side) that uses the **live provider client** to build `messages[]` (so the shape is provider-native for both Anthropic and OpenAI runs) plus system prompt + diagnostics. One new CLI subcommand (`ask`) with a thin REPL that calls `client.chat(messages, [ANSWER_TOOL], systemPrompt)` per question.

**Why client-injection:** the spec promises "byte-identical to what the agent loop fed the model." Hand-rolling tool_result blocks works only for Anthropic shape; OpenAI uses `{role: "tool"}` messages plus synthesized user messages for images. Passing the resolved provider client to `rebuildMessages` and calling its `userMessage` / `toolResultMessages` keeps the shape correct for both providers and matches exactly what the original agent loop produced.

**Tech Stack:** TypeScript, Bun runtime, `bun:test` test framework, `@anthropic-ai/sdk` and `openai` provider SDKs (existing). No new dependencies.

**Spec:** `docs/session-revival-spec.md`. Read it before starting. **Linear:** PRI-1579.

---

## File structure

**Create:**
- `src/revival/rebuild-messages.ts` — the core `rebuildMessages` function
- `src/revival/answer-tool.ts` — `ANSWER_TOOL` definition and `extractAnswer` helper
- `src/revival/system-prompt-addendum.ts` — small builder for the revival header that prepends to the recorded system prompt
- `src/revival/index.ts` — barrel exports
- `src/cli/ask.ts` — the CLI command + REPL
- `test/revival/rebuild-messages.test.ts` — unit tests
- `test/revival/answer-tool.test.ts` — unit tests for the answer-extraction helper
- `test/revival/system-prompt-addendum.test.ts` — unit tests for the addendum builder
- `test/revival/fixtures.ts` — helpers that build `run.jsonl` fixture content
- `test/cli/ask.test.ts` — CLI args parsing test

**Modify:**
- `src/evidence/logger.ts` — add `logToolDefinitions(tools)`; add optional `mediaType` to `ToolResultFields`
- `src/agent/agent.ts` — call `logger.logToolDefinitions(tools)` after `logSystemPrompt`
- `src/adapters/web/adapter.ts` — pass `mediaType: "image/png"` on `tool_result` events that include screenshots
- `src/cli/args.ts` — add `AskArgs` type, `parseAskArgs`, wire `"ask"` case
- `src/index.ts` — add `case "ask"` dispatch
- `docs/format.md` — document the `tool_definitions` event and the `mediaType` field

**No changes:** `src/models/provider.ts`, `src/models/anthropic.ts`, `src/models/openai.ts`. Revival uses the existing `LLMClient.chat()` and `userMessage()` methods unchanged.

---

## Task 1: Add `logToolDefinitions` to EvidenceLogger

**Files:**
- Modify: `src/evidence/logger.ts`
- Test: `test/evidence/logger.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/evidence/logger.test.ts`:

```typescript
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, test, expect } from "bun:test";
import { EvidenceLogger } from "../../src/evidence/logger";

describe("logToolDefinitions", () => {
  test("writes a tool_definitions event with the full tools array", () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-logger-"));
    try {
      const logger = new EvidenceLogger(dir);
      logger.logSystemPrompt("hello system");
      logger.logToolDefinitions([
        { name: "click", description: "Click", parameters: { type: "object" } },
        { name: "report_result", description: "Report", parameters: { type: "object" } },
      ]);
      const lines = readFileSync(join(dir, "run.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const evt = lines.find((e) => e.type === "tool_definitions");
      expect(evt).toBeDefined();
      expect(evt.tools).toHaveLength(2);
      expect(evt.tools[0].name).toBe("click");
      expect(evt.tools[1].name).toBe("report_result");
      // parentEventId must chain after the system_prompt event
      const sysEvt = lines.find((e) => e.type === "system_prompt");
      expect(evt.parentEventId).toBe(sysEvt.eventId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/evidence/logger.test.ts -t "logToolDefinitions"`
Expected: FAIL with "logToolDefinitions is not a function" or similar.

- [ ] **Step 3: Implement `logToolDefinitions`**

Edit `src/evidence/logger.ts`. After `logSystemPrompt`, add:

```typescript
logToolDefinitions(
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
): void {
  this.writeEvent("tool_definitions", { tools });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/evidence/logger.test.ts -t "logToolDefinitions"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evidence/logger.ts test/evidence/logger.test.ts
git commit -m "$(cat <<'EOF'
evidence: add logToolDefinitions for session-revival fidelity (PRI-1579)

The run.jsonl currently captures tool *calls* but not tool *schemas*.
Revival needs the schemas to faithfully tell the model what it had
access to during the original run. Additive event; no schemaVersion bump.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 2: Add `mediaType` field to `ToolResultFields` and thread through web adapter

**Files:**
- Modify: `src/evidence/logger.ts`
- Modify: `src/adapters/web/adapter.ts`
- Test: `test/evidence/logger.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/evidence/logger.test.ts`:

```typescript
test("logToolResult records optional mediaType for images", () => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-logger-"));
  try {
    const logger = new EvidenceLogger(dir);
    logger.logToolResult({
      turn: 1,
      toolUseId: "tu_1",
      name: "screenshot",
      durationMs: 12,
      text: "",
      image: "screenshots/001.png",
      mediaType: "image/png",
      error: false,
    });
    const line = readFileSync(join(dir, "run.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.type === "tool_result");
    expect(line.mediaType).toBe("image/png");
    expect(line.image).toBe("screenshots/001.png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/evidence/logger.test.ts -t "mediaType"`
Expected: FAIL with TypeScript error on `mediaType` not being assignable, or runtime missing field.

- [ ] **Step 3: Add `mediaType` to `ToolResultFields`**

Edit `src/evidence/logger.ts`, in `ToolResultFields`:

```typescript
export interface ToolResultFields {
  turn: number;
  toolUseId: string;
  name: string;
  durationMs: number;
  text: string;
  image?: string;
  /** Media type of the image (e.g. "image/png"). Always set when `image` is set. */
  mediaType?: string;
  artifact?: string;
  capturePath?: string;
  textTruncated?: true;
  textBytes?: number;
  error: boolean;
}
```

No body change needed — the spread `body = { ...fields }` already propagates the new field.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/evidence/logger.test.ts -t "mediaType"`
Expected: PASS.

- [ ] **Step 5: Set `mediaType` on web-adapter image results**

Find every place in `src/adapters/web/adapter.ts` that produces a `tool_result` with an `image` field (search: `image:` and `imagePath`). For each, also set `mediaType: "image/png"`. The web adapter's screenshot pipeline produces PNG today.

Concretely: find calls where the adapter constructs a `ToolResult` with `image: { data, mediaType }` and `logToolResult` is called with `image: <path>` — at each `logToolResult` call site involving an image, add `mediaType: "image/png"`.

Run `grep -n 'image:' src/adapters/web/adapter.ts` to enumerate sites.

- [ ] **Step 6: Run the existing adapter tests**

Run: `bun test test/adapters/`
Expected: PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add src/evidence/logger.ts src/adapters/web/adapter.ts test/evidence/logger.test.ts
git commit -m "$(cat <<'EOF'
evidence: add mediaType to tool_result for image rehydration (PRI-1579)

run.jsonl logs the relative path to screenshots but not the media type.
Revival reads the file at replay time and needs to slot it back into
the provider-native image block, which requires the type. Additive
optional field.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 3: Wire `logToolDefinitions` call from `runAgent`

**Files:**
- Modify: `src/agent/agent.ts`
- Test: `test/agent/agent.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test in `test/agent/agent.test.ts` (the existing file already mocks the logger). Add a `logToolDefinitions` spy to the mock:

```typescript
test("agent logs tool_definitions after system prompt", async () => {
  const calls: Array<{ kind: string; payload: unknown }> = [];
  const mockLogger = {
    // ... existing mock methods ...
    logToolDefinitions: (tools: unknown) => {
      calls.push({ kind: "logToolDefinitions", payload: tools });
    },
    logSystemPrompt: (prompt: string) => {
      calls.push({ kind: "logSystemPrompt", payload: prompt });
    },
    // ... rest of mock unchanged ...
  } as unknown as EvidenceLogger;

  // Minimal mock client that calls report_result immediately
  const mockClient: LLMClient = {
    chat: async () => ({
      text: "",
      toolCalls: [{ id: "t1", name: "report_result", arguments: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } }],
      stopReason: "tool_use",
      rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
    userMessage: (c: string) => ({ role: "user", content: c }),
    toolResultMessages: () => [],
  };

  const mockAdapter = {
    name: "web",
    toolDefinitions: () => [{ name: "click", description: "Click", parameters: { type: "object" } }],
    isMutatingTool: () => false,
    executeTool: async () => ({ text: "ok" }),
  } as unknown as Adapter;

  await runAgent(card, mockAdapter, mockClient, mockLogger, "http://x", {
    runId: makeRunId("test"),
    budgetMs: 60000,
    reflectionInterval: 0,
  });

  const sysIdx = calls.findIndex((c) => c.kind === "logSystemPrompt");
  const toolDefsIdx = calls.findIndex((c) => c.kind === "logToolDefinitions");
  expect(toolDefsIdx).toBeGreaterThan(sysIdx);
  const tools = calls[toolDefsIdx].payload as Array<{ name: string }>;
  expect(tools.map((t) => t.name)).toContain("click");
  expect(tools.map((t) => t.name)).toContain("report_result");
});
```

(Use the existing mock setup pattern from the file; only the relevant fields are shown here.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/agent/agent.test.ts -t "tool_definitions after system prompt"`
Expected: FAIL — the agent doesn't call `logToolDefinitions` yet.

- [ ] **Step 3: Implement the call**

Edit `src/agent/agent.ts`. After the `logger.logSystemPrompt(systemPrompt);` line (around line 161), add:

```typescript
logger.logToolDefinitions(tools);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/agent/agent.test.ts -t "tool_definitions after system prompt"`
Expected: PASS.

- [ ] **Step 5: Run full agent test suite to check no regressions**

Run: `bun test test/agent/`
Expected: All PASS. If any existing test fails because its mock logger doesn't implement `logToolDefinitions`, add a `logToolDefinitions: () => {}` stub to that test's mock.

- [ ] **Step 6: Commit**

```bash
git add src/agent/agent.ts test/agent/agent.test.ts
git commit -m "$(cat <<'EOF'
agent: log tool_definitions at run start (PRI-1579)

Closes the only fidelity gap for session revival: previously the run
captured tool *calls* but not tool *schemas*. Now revivers can
faithfully tell the model what it had access to.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 4: Build `ANSWER_TOOL` and `extractAnswer` helper

**Files:**
- Create: `src/revival/answer-tool.ts`
- Create: `test/revival/answer-tool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/revival/answer-tool.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { ANSWER_TOOL, extractAnswer } from "../../src/revival/answer-tool";
import type { ToolCall } from "../../src/models/provider";

describe("ANSWER_TOOL", () => {
  test("has shape compatible with ToolDefinition", () => {
    expect(ANSWER_TOOL.name).toBe("answer");
    expect(typeof ANSWER_TOOL.description).toBe("string");
    expect(ANSWER_TOOL.parameters.type).toBe("object");
    const props = (ANSWER_TOOL.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.answer).toBeDefined();
    expect((ANSWER_TOOL.parameters as { required: string[] }).required).toEqual(["answer"]);
  });
});

describe("extractAnswer", () => {
  test("returns {kind:'structured', text} when an answer tool call is present", () => {
    const calls: ToolCall[] = [{ id: "t1", name: "answer", arguments: { answer: "Because the form had validation errors." } }];
    const result = extractAnswer(calls, "ignored fallback text");
    expect(result).toEqual({ kind: "structured", text: "Because the form had validation errors." });
  });

  test("returns {kind:'unstructured', text} when no answer tool call but text is present", () => {
    const result = extractAnswer([], "I clicked because the page told me to.");
    expect(result).toEqual({ kind: "unstructured", text: "I clicked because the page told me to." });
  });

  test("ignores non-answer tool calls and falls back to text", () => {
    const calls: ToolCall[] = [{ id: "t1", name: "click", arguments: {} }];
    const result = extractAnswer(calls, "fallback");
    expect(result).toEqual({ kind: "unstructured", text: "fallback" });
  });

  test("handles non-string answer arg gracefully", () => {
    const calls: ToolCall[] = [{ id: "t1", name: "answer", arguments: { answer: 42 as unknown as string } }];
    const result = extractAnswer(calls, "fallback");
    expect(result).toEqual({ kind: "unstructured", text: "fallback" });
  });

  test("returns empty unstructured when neither answer call nor text", () => {
    const result = extractAnswer([], "");
    expect(result).toEqual({ kind: "unstructured", text: "" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/revival/answer-tool.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `ANSWER_TOOL` and `extractAnswer`**

Create `src/revival/answer-tool.ts`:

```typescript
import type { ToolCall, ToolDefinition } from "../models/provider";

export const ANSWER_TOOL: ToolDefinition = {
  name: "answer",
  description:
    "Reply to the operator's question about this completed test run. " +
    "This is the only tool available; the original run's tools are listed in the system prompt for context but cannot be invoked.",
  parameters: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "Your reply to the operator's question. Reason out loud as needed.",
      },
    },
    required: ["answer"],
  },
};

export type ExtractedAnswer =
  | { kind: "structured"; text: string }
  | { kind: "unstructured"; text: string };

export function extractAnswer(toolCalls: ToolCall[], fallbackText: string): ExtractedAnswer {
  const answerCall = toolCalls.find((tc) => tc.name === "answer");
  if (answerCall) {
    const arg = answerCall.arguments.answer;
    if (typeof arg === "string") {
      return { kind: "structured", text: arg };
    }
  }
  return { kind: "unstructured", text: fallbackText };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/revival/answer-tool.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/revival/answer-tool.ts test/revival/answer-tool.test.ts
git commit -m "$(cat <<'EOF'
revival: add ANSWER_TOOL definition and extractor (PRI-1579)

The single tool the model gets during revival. Structured-vs-unstructured
return type lets the REPL annotate fallback replies without re-prompting.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 5: Build the system-prompt revival addendum

**Files:**
- Create: `src/revival/system-prompt-addendum.ts`
- Create: `test/revival/system-prompt-addendum.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/revival/system-prompt-addendum.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { buildRevivalAddendum } from "../../src/revival/system-prompt-addendum";

describe("buildRevivalAddendum", () => {
  const tools = [
    { name: "click", description: "Click an element by selector.", parameters: { type: "object" } },
    { name: "report_result", description: "Report verdict.", parameters: { type: "object" } },
  ];

  test("includes a clear revival framing", () => {
    const out = buildRevivalAddendum(tools, { fallback: false });
    expect(out).toContain("REVIVAL");
    expect(out.toLowerCase()).toContain("completed");
    expect(out).toContain("answer");
  });

  test("lists original tools as prose with name and description", () => {
    const out = buildRevivalAddendum(tools, { fallback: false });
    expect(out).toContain("click");
    expect(out).toContain("Click an element by selector.");
    expect(out).toContain("report_result");
    expect(out).toContain("Report verdict.");
  });

  test("marks the prose as fallback when fallback=true", () => {
    const out = buildRevivalAddendum(tools, { fallback: true });
    expect(out).toContain("fallback");
    expect(out.toLowerCase()).toContain("drift");
  });

  test("instructs the model to use the answer tool only", () => {
    const out = buildRevivalAddendum(tools, { fallback: false });
    expect(out.toLowerCase()).toContain("answer");
    expect(out).toContain("cannot");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/revival/system-prompt-addendum.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `buildRevivalAddendum`**

Create `src/revival/system-prompt-addendum.ts`:

```typescript
import type { ToolDefinition } from "../models/provider";

export interface AddendumOptions {
  /**
   * True if the tool list was reconstructed from the live adapter
   * because the recorded run.jsonl had no tool_definitions event.
   * Surfaces a drift warning in the addendum so the model knows the
   * schemas might not match what it actually saw.
   */
  fallback: boolean;
}

export function buildRevivalAddendum(
  tools: ToolDefinition[],
  opts: AddendumOptions,
): string {
  const toolLines = tools
    .map((t) => `- \`${t.name}\` — ${t.description.split("\n")[0]}`)
    .join("\n");

  const driftNote = opts.fallback
    ? "\n\nNOTE: The above tool list was reconstructed from the current adapter code because this run did not record its tool definitions. Tool schemas may have drifted between when the run was recorded and now.\n"
    : "";

  return `

---

REVIVAL MODE — this run has already completed. You are not continuing the test.

The operator (a human or another agent) is asking you questions about decisions you made during the run. The conversation above is your transcript. You cannot make tool calls to the application; the original tools listed below are shown for your reference only.

Original tools available during the run:
${toolLines}
${driftNote}
You have exactly one callable tool: \`answer\`. Use it to reply. You can reason in plain text first if you want; the final reply goes in \`answer(answer: ...)\`. If you cannot or do not want to use the answer tool, just reply in plain text — it will be accepted.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/revival/system-prompt-addendum.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/revival/system-prompt-addendum.ts test/revival/system-prompt-addendum.test.ts
git commit -m "$(cat <<'EOF'
revival: addendum builder for the system prompt (PRI-1579)

Tells the revival model it's in post-run review mode and lists the
original tools as prose so it knows what it had access to.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 6: Build run.jsonl fixture helpers and a fake client

**Files:**
- Create: `test/revival/fixtures.ts`

This is a no-test helper module that all subsequent revival tests will import. It bundles `run.jsonl` event scaffolding AND a fake `LLMClient` (Anthropic-shaped, matching what tests assert against) so each test doesn't re-roll its own.

- [ ] **Step 1: Implement the fixture helpers**

Create `test/revival/fixtures.ts`:

```typescript
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Build an ad-hoc run directory containing run.jsonl with the given events.
 * Returns the absolute directory path. Caller is responsible for cleanup
 * via `cleanup(dir)`.
 */
export function makeRunDir(events: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-revival-"));
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  // Assign eventId/parentEventId chain if missing
  let lastId = 0;
  const chained = events.map((e, i) => {
    const eventId = (e.eventId as number) ?? i + 1;
    const parentEventId = (e.parentEventId as number) ?? lastId;
    lastId = eventId;
    return {
      eventId,
      parentEventId,
      ts: e.ts ?? new Date().toISOString(),
      ...e,
    };
  });
  writeFileSync(
    join(dir, "run.jsonl"),
    chained.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return dir;
}

export function writeScreenshot(runDir: string, name: string, bytes: Buffer): string {
  const rel = `screenshots/${name}`;
  writeFileSync(join(runDir, rel), bytes);
  return rel;
}

export function writeArtifact(runDir: string, name: string, content: string): string {
  const rel = `artifacts/${name}`;
  writeFileSync(join(runDir, rel), content);
  return rel;
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Tiny 1×1 PNG (transparent) — for image-rehydration tests. */
export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAEAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

/**
 * Minimal LLMClient stand-in for rebuildMessages tests. Uses the real
 * exported anthropicToolResultMessages so tests assert against the
 * provider-native Anthropic shape without depending on an API key.
 * chat() is intentionally unimplemented — these tests never call it.
 */
export function makeFakeAnthropicClient(): {
  userMessage: (content: string) => unknown;
  toolResultMessages: typeof import("../../src/models/anthropic").anthropicToolResultMessages;
} {
  const { anthropicToolResultMessages } = require("../../src/models/anthropic");
  return {
    userMessage: (content: string) => ({ role: "user", content }),
    toolResultMessages: anthropicToolResultMessages,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add test/revival/fixtures.ts
git commit -m "$(cat <<'EOF'
revival: test fixture helpers for run.jsonl rebuild tests (PRI-1579)

makeRunDir(events) + writeScreenshot/writeArtifact + makeFakeAnthropicClient
for the upcoming rebuild-messages tests. Shared module so every test
doesn't re-roll the same boilerplate.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 7: `rebuildMessages` — happy path (no images, no reflection, no terminal hazards)

**Files:**
- Create: `src/revival/rebuild-messages.ts`
- Create: `src/revival/index.ts`
- Create: `test/revival/rebuild-messages.test.ts`

This task implements the simplest case: a 2-turn run that ends with `report_result`, no images, no reflections.

- [ ] **Step 1: Write the failing test**

Create `test/revival/rebuild-messages.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { rebuildMessages } from "../../src/revival/rebuild-messages";
import { makeRunDir, cleanup, makeFakeAnthropicClient } from "./fixtures";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!);
});

describe("rebuildMessages — happy path", () => {
  test("returns systemPrompt, messages, modelId, adapterName for a 2-turn run", () => {
    const dir = makeRunDir([
      { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "web", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 0, toolTimeoutMs: 30000, contextTreeBytes: 0 },
      { type: "system_prompt", content: "You are a test agent." },
      { type: "tool_definitions", tools: [
        { name: "click", description: "Click", parameters: { type: "object" } },
        { name: "report_result", description: "Report", parameters: { type: "object" } },
      ]},
      { type: "user_message", turn: 0, content: "Test the login page at http://x" },
      { type: "llm_request", turn: 1, messageCount: 1 },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "",
        thinking: [],
        toolCalls: [{ id: "t1", name: "click", arguments: { selector: "#login" } }],
        usage: { inputTokens: 100, outputTokens: 20 },
        rawAssistantMessage: { role: "assistant", content: [
          { type: "tool_use", id: "t1", name: "click", input: { selector: "#login" } },
        ]},
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "click", arguments: { selector: "#login" } },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "click", durationMs: 5, text: "ok", error: false },
      { type: "run_end", status: "pass", summary: "done", reasoning: "done", observationCount: 0, observations: [], durationMs: 100, usage: { inputTokens: 100, outputTokens: 20, turns: 1 } },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    expect(result.modelId).toBe("claude-sonnet-4-6");
    expect(result.adapterName).toBe("web");
    expect(result.systemPrompt).toContain("You are a test agent.");
    expect(result.systemPrompt).toContain("REVIVAL");
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
    // First message: initial user turn
    const m0 = result.messages[0] as { role: string; content: unknown };
    expect(m0.role).toBe("user");
    // Second message: assistant raw
    const m1 = result.messages[1] as { role: string };
    expect(m1.role).toBe("assistant");
    expect(result.warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/revival/rebuild-messages.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement minimal `rebuildMessages`**

Create `src/revival/rebuild-messages.ts`:

```typescript
import { readFileSync } from "fs";
import { join } from "path";
import type { LLMClient, ToolCall, ToolDefinition, ToolResult } from "../models/provider";
import { buildRevivalAddendum } from "./system-prompt-addendum";

/**
 * The subset of LLMClient that rebuildMessages depends on. Both
 * userMessage and toolResultMessages are pure (no API calls); chat is
 * not invoked. Tests can supply a fake; production passes a real
 * provider client.
 */
export type MessageBuilder = Pick<LLMClient, "userMessage" | "toolResultMessages">;

export interface RebuildResult {
  systemPrompt: string;
  messages: unknown[];
  toolDefs: ToolDefinition[];
  modelId: string;
  adapterName: string;
  warnings: string[];
}

interface RawEvent {
  eventId: number;
  parentEventId: number;
  ts: string;
  type: string;
  [k: string]: unknown;
}

export function rebuildMessages(
  runDir: string,
  client: MessageBuilder,
  upToTurn?: number,
): RebuildResult {
  const path = join(runDir, "run.jsonl");
  const text = readFileSync(path, "utf8");
  const events: RawEvent[] = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RawEvent);

  if (events.length === 0) {
    throw new Error(`Run ${runDir} produced no events`);
  }

  // Discover modelId and adapterName from run_start
  const runStart = events.find((e) => e.type === "run_start");
  if (!runStart) throw new Error(`Run ${runDir} has no run_start event`);
  const modelId = String(runStart.model ?? "");
  const adapterName = String(runStart.adapter ?? "");

  // System prompt body
  const sysEvt = events.find((e) => e.type === "system_prompt");
  if (!sysEvt) throw new Error(`Run ${runDir} has no system_prompt event`);
  const systemPromptBody = String(sysEvt.content ?? "");

  // Tool definitions (from event if present)
  const toolDefsEvt = events.find((e) => e.type === "tool_definitions");
  const toolDefs: ToolDefinition[] = toolDefsEvt
    ? (toolDefsEvt.tools as ToolDefinition[])
    : [];

  const warnings: string[] = [];
  const systemPrompt =
    systemPromptBody + buildRevivalAddendum(toolDefs, { fallback: !toolDefsEvt });

  // Determine last turn (for range checks and "include everything" semantics)
  const turnsSeen = events
    .map((e) => (typeof e.turn === "number" ? (e.turn as number) : undefined))
    .filter((t): t is number => t !== undefined);
  const lastTurn = turnsSeen.length > 0 ? Math.max(...turnsSeen) : 0;

  if (upToTurn !== undefined && upToTurn > lastTurn) {
    throw new Error(
      `--turn ${upToTurn} out of range; run ended at turn ${lastTurn}`,
    );
  }

  const cutoff = upToTurn ?? lastTurn;

  // Walk events, building messages
  const messages: unknown[] = [];

  // Initial user message: turn 0 — uses the client's native shape
  const initialUser = events.find(
    (e) => e.type === "user_message" && (e.turn === 0 || e.turn === undefined),
  );
  if (initialUser) {
    messages.push(client.userMessage(String(initialUser.content ?? "")));
  }

  // Group events by turn (excluding turn 0)
  const turnNumbers = Array.from(
    new Set(
      events
        .filter((e) => (e.turn as number | undefined) !== undefined && (e.turn as number) >= 1 && (e.turn as number) <= cutoff)
        .map((e) => e.turn as number),
    ),
  ).sort((a, b) => a - b);

  for (const turn of turnNumbers) {
    const turnEvents = events.filter((e) => e.turn === turn);
    const llmResp = turnEvents.find((e) => e.type === "llm_response");
    if (llmResp) {
      messages.push(llmResp.rawAssistantMessage);
    }
    // tool_result blocks — built via client.toolResultMessages so the
    // shape is provider-native (Anthropic vs OpenAI handle it differently)
    const toolResultEvts = turnEvents.filter((e) => e.type === "tool_result");
    const toolCallEvts = turnEvents.filter((e) => e.type === "tool_call");
    if (toolResultEvts.length > 0) {
      const calls: ToolCall[] = toolCallEvts.map((tc) => ({
        id: String(tc.toolUseId),
        name: String(tc.name),
        arguments: (tc.arguments as Record<string, unknown>) ?? {},
      }));
      const results: ToolResult[] = toolResultEvts.map((tr) =>
        rebuildToolResult(tr, runDir, warnings),
      );
      messages.push(...client.toolResultMessages(calls, results));
    }
  }

  return { systemPrompt, messages, toolDefs, modelId, adapterName, warnings };
}

/**
 * Reconstruct a ToolResult from a logged tool_result event, rehydrating
 * spilled image / text / capture content from disk. Returns a ToolResult
 * the client's toolResultMessages can consume directly.
 */
function rebuildToolResult(
  tr: RawEvent,
  runDir: string,
  warnings: string[],
): ToolResult {
  const text = String(tr.text ?? "");
  const result: ToolResult = { text };

  const textTruncated = tr.textTruncated === true;
  const artifactRel = tr.artifact as string | undefined;
  if (textTruncated && artifactRel) {
    result.text = readFileSync(join(runDir, artifactRel), "utf8");
  }
  const capturePathRel = tr.capturePath as string | undefined;
  if (capturePathRel) {
    result.text = readFileSync(join(runDir, capturePathRel), "utf8");
  }

  const imageRel = tr.image as string | undefined;
  if (imageRel) {
    let mediaType = tr.mediaType as string | undefined;
    if (!mediaType) {
      mediaType = "image/png";
      warnings.push(
        `tool_result for ${String(tr.name)} had no mediaType; defaulting to image/png (older run.jsonl format)`,
      );
    }
    const data = readFileSync(join(runDir, imageRel)).toString("base64");
    result.image = { data, mediaType };
  }

  return result;
}
```

Create `src/revival/index.ts`:

```typescript
export { rebuildMessages, type RebuildResult } from "./rebuild-messages";
export { ANSWER_TOOL, extractAnswer, type ExtractedAnswer } from "./answer-tool";
export { buildRevivalAddendum } from "./system-prompt-addendum";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/revival/rebuild-messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/revival/rebuild-messages.ts src/revival/index.ts test/revival/rebuild-messages.test.ts
git commit -m "$(cat <<'EOF'
revival: rebuildMessages happy path (PRI-1579)

Walks run.jsonl, emits system prompt + native messages array up to a
chosen turn. Happy path only: no images, no reflection-checkpoints, no
terminal-turn hazards — those come in subsequent commits.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 8: `rebuildMessages` — image rehydration from disk

**Files:**
- Modify: `src/revival/rebuild-messages.ts`
- Modify: `test/revival/rebuild-messages.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/revival/rebuild-messages.test.ts`:

```typescript
import { writeScreenshot, ONE_PIXEL_PNG } from "./fixtures";

describe("rebuildMessages — image rehydration", () => {
  test("reads screenshot bytes from disk and slots them into the tool_result block", () => {
    const dir = makeRunDir([
      { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "web", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 0, toolTimeoutMs: 30000, contextTreeBytes: 0 },
      { type: "system_prompt", content: "sys" },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t1", name: "screenshot", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "screenshot", arguments: {} },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "screenshot", durationMs: 5, text: "", image: "screenshots/001.png", mediaType: "image/png", error: false },
    ]);
    cleanups.push(dir);
    writeScreenshot(dir, "001.png", ONE_PIXEL_PNG);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const userTurn = result.messages.find(
      (m) => (m as { role?: string }).role === "user" && Array.isArray((m as { content: unknown }).content),
    ) as { role: string; content: unknown[] };
    expect(userTurn).toBeDefined();
    const block = userTurn.content[0] as {
      type: string;
      tool_use_id: string;
      content: Array<{ type: string; source?: { type: string; media_type: string; data: string } }>;
    };
    expect(block.type).toBe("tool_result");
    const imageBlock = block.content.find((c) => c.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.source!.media_type).toBe("image/png");
    expect(imageBlock!.source!.data).toBe(ONE_PIXEL_PNG.toString("base64"));
  });

  test("warns and defaults to image/png when mediaType is missing on an old-format event", () => {
    const dir = makeRunDir([
      { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "web", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 0, toolTimeoutMs: 30000, contextTreeBytes: 0 },
      { type: "system_prompt", content: "sys" },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t1", name: "screenshot", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "screenshot", arguments: {} },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "screenshot", durationMs: 5, text: "", image: "screenshots/001.png", error: false },
    ]);
    cleanups.push(dir);
    writeScreenshot(dir, "001.png", ONE_PIXEL_PNG);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    expect(result.warnings.some((w) => w.includes("mediaType"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/revival/rebuild-messages.test.ts -t "image rehydration"`
Expected: FAIL — current implementation passes only text content.

- [ ] **Step 3: Confirm image rehydration already works**

The `rebuildToolResult` helper added in Task 7 already handles image rehydration: when `tr.image` is set, it reads the bytes from disk, base64-encodes them, and assigns `result.image = { data, mediaType }`. `client.toolResultMessages` then produces the provider-native shape (Anthropic uses `{type: "image", source: {type: "base64", media_type, data}}`; OpenAI uses `image_url` blocks).

This task's value is **proving** the rehydration behavior end-to-end through the fake client. The implementation should already pass — if it doesn't, find the gap and patch it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/revival/rebuild-messages.test.ts`
Expected: All PASS (existing happy-path test still passes).

- [ ] **Step 5: Commit**

```bash
git add src/revival/rebuild-messages.ts test/revival/rebuild-messages.test.ts
git commit -m "$(cat <<'EOF'
revival: rehydrate screenshot bytes from disk (PRI-1579)

run.jsonl stores the screenshot path; revival needs the bytes inline
in the provider-native image block. Reads on demand, warns when the
older format has no mediaType.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 9: `rebuildMessages` — text artifact and TUI capture rehydration

**Files:**
- Modify: `src/revival/rebuild-messages.ts`
- Modify: `test/revival/rebuild-messages.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/revival/rebuild-messages.test.ts`:

```typescript
import { writeArtifact } from "./fixtures";

describe("rebuildMessages — text rehydration", () => {
  test("reads the artifact when tool_result.textTruncated is true", () => {
    const dir = makeRunDir([
      { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "web", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 0, toolTimeoutMs: 30000, contextTreeBytes: 0 },
      { type: "system_prompt", content: "sys" },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t1", name: "extract", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "extract", input: {} }] },
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "extract", arguments: {} },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "extract", durationMs: 5, text: "", textTruncated: true, textBytes: 1024, artifact: "artifacts/001.txt", error: false },
    ]);
    cleanups.push(dir);
    writeArtifact(dir, "001.txt", "THE FULL TEXT THE AGENT SAW");

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const userTurn = result.messages[result.messages.length - 1] as { content: Array<{ content: string }> };
    expect(userTurn.content[0].content).toBe("THE FULL TEXT THE AGENT SAW");
  });
});

describe("rebuildMessages — TUI capture rehydration", () => {
  test("reads the .ansi file when capturePath is set", () => {
    const dir = makeRunDir([
      { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "tui", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 0, toolTimeoutMs: 30000, contextTreeBytes: 0 },
      { type: "system_prompt", content: "sys" },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t1", name: "read_screen", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_screen", input: {} }] },
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "read_screen", arguments: {} },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "read_screen", durationMs: 5, text: "captures/000.ansi", capturePath: "captures/000.ansi", error: false },
    ]);
    cleanups.push(dir);
    // simulate the capture
    const { writeFileSync, mkdirSync } = require("fs");
    const { join } = require("path");
    mkdirSync(join(dir, "captures"), { recursive: true });
    writeFileSync(join(dir, "captures/000.ansi"), "RAW ANSI SCREEN CONTENT");

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const userTurn = result.messages[result.messages.length - 1] as { content: Array<{ content: string }> };
    expect(userTurn.content[0].content).toBe("RAW ANSI SCREEN CONTENT");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/revival/rebuild-messages.test.ts -t "rehydration"`
Expected: Two FAILs.

- [ ] **Step 3: Confirm text and capture rehydration already works**

The `rebuildToolResult` helper added in Task 7 already reads `artifacts/N.txt` when `textTruncated` is true and reads `captures/NNN.ansi` when `capturePath` is set, slotting the content back into `result.text`. This task verifies the behavior end-to-end. If the test fails, patch the helper.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/revival/rebuild-messages.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/revival/rebuild-messages.ts test/revival/rebuild-messages.test.ts
git commit -m "$(cat <<'EOF'
revival: rehydrate spilled text and TUI captures from disk (PRI-1579)

Large tool outputs and TUI screen captures spill out of run.jsonl to
keep it streamable. Revival reads them back so the model sees what
the original run saw.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 10: `rebuildMessages` — reflection-checkpoint weave

**Files:**
- Modify: `src/revival/rebuild-messages.ts`
- Modify: `test/revival/rebuild-messages.test.ts`

**The trickiest task.** A `user_message` event emitted at the same turn as a `tool_result` group is the reflection-checkpoint reminder. It must be woven into the same user-turn content as a trailing `text` block (matching the Anthropic provider's `toolResultMessages` shape), not as a standalone user message.

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe("rebuildMessages — reflection checkpoint", () => {
  test("weaves the reflection reminder into the same user turn as tool_result", () => {
    const dir = makeRunDir([
      { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "web", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 1, toolTimeoutMs: 30000, contextTreeBytes: 0 },
      { type: "system_prompt", content: "sys" },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t1", name: "click", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "click", input: {} }] },
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "click", arguments: {} },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "click", durationMs: 5, text: "ok", error: false },
      { type: "event", name: "reflection_checkpoint", turn: 1, ordinal: 1, traceLength: 1 },
      { type: "user_message", turn: 1, content: "<SYSTEM-REMINDER> reflect now </SYSTEM-REMINDER>" },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    // The user turn after the assistant should contain a tool_result block AND a text block (the reflection reminder)
    const lastUser = result.messages[result.messages.length - 1] as {
      role: string;
      content: Array<{ type: string; text?: string; tool_use_id?: string }>;
    };
    expect(lastUser.role).toBe("user");
    const types = lastUser.content.map((b) => b.type);
    expect(types).toContain("tool_result");
    expect(types).toContain("text");
    const textBlock = lastUser.content.find((b) => b.type === "text");
    expect(textBlock!.text).toContain("reflect now");
    // CRITICAL: there must NOT be a separate standalone user message
    // appended after the tool_result user message.
    const userTurns = result.messages.filter(
      (m) => (m as { role?: string }).role === "user",
    );
    expect(userTurns).toHaveLength(2); // initial + tool_result-with-reflection
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/revival/rebuild-messages.test.ts -t "reflection checkpoint"`
Expected: FAIL — current implementation either ignores the reflection user_message or emits it standalone.

- [ ] **Step 3: Implement reflection weaving via `extraUserText`**

Edit `src/revival/rebuild-messages.ts`. Inside the turn loop, after building tool_result events for the turn, look for a `user_message` event with the same `turn` — when both exist, that user_message is a reflection-checkpoint reminder and must be passed as `extraUserText` to `client.toolResultMessages`.

Replace the `if (toolResultEvts.length > 0)` block from Task 7 with:

```typescript
if (toolResultEvts.length > 0) {
  const calls: ToolCall[] = toolCallEvts.map((tc) => ({
    id: String(tc.toolUseId),
    name: String(tc.name),
    arguments: (tc.arguments as Record<string, unknown>) ?? {},
  }));
  const results: ToolResult[] = toolResultEvts.map((tr) =>
    rebuildToolResult(tr, runDir, warnings),
  );
  const reflectionReminder = turnEvents.find((e) => e.type === "user_message");
  const extraUserText = reflectionReminder
    ? String(reflectionReminder.content ?? "")
    : undefined;
  messages.push(...client.toolResultMessages(calls, results, extraUserText));
}
```

Note: `client.toolResultMessages` from the Anthropic provider weaves `extraUserText` as a trailing `{type: "text"}` block inside the same user turn; the OpenAI provider appends a separate user message after the per-call tool messages. Both shapes match what the original agent loop produced, so byte-identity is preserved.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/revival/rebuild-messages.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/revival/rebuild-messages.ts test/revival/rebuild-messages.test.ts
git commit -m "$(cat <<'EOF'
revival: weave reflection reminders into tool_result user turn (PRI-1579)

The agent loop appends reflection-checkpoint reminders as text blocks
inside the same user turn as tool_result blocks (via toolResultMessages'
extraUserText). The reviver must match this shape — emitting them as
standalone user turns would produce two adjacent user messages, which
Anthropic rejects.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 11: `rebuildMessages` — deadline-grace turn

**Files:**
- Modify: `src/revival/rebuild-messages.ts`
- Modify: `test/revival/rebuild-messages.test.ts`

The deadline-grace turn is `lastTurn + 1` and is a *new* turn whose initial event is a `user_message` with no preceding `tool_result` group. It must emit as a standalone user message.

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe("rebuildMessages — deadline grace turn", () => {
  test("emits the deadline reminder as a standalone user message at the grace turn", () => {
    const dir = makeRunDir([
      { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "web", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 0, toolTimeoutMs: 30000, contextTreeBytes: 0 },
      { type: "system_prompt", content: "sys" },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "end_turn", text: "looking",
        thinking: [], toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "text", text: "looking" }] },
      },
      { type: "event", name: "deadline_reminder", budgetMs: 60000, elapsedMs: 60001 },
      { type: "user_message", turn: 2, content: "<SYSTEM-REMINDER> time's up </SYSTEM-REMINDER>" },
      { type: "llm_response", turn: 2, stopReason: "tool_use", text: "",
        thinking: [], toolCalls: [{ id: "g1", name: "report_result", arguments: { status: "investigate", summary: "stuck", reasoning: "ran out", observations: [] } }], usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "g1", name: "report_result", input: { status: "investigate", summary: "stuck", reasoning: "ran out", observations: [] } }] },
      },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const roles = result.messages.map((m) => (m as { role?: string }).role);
    // Sequence: user(turn 0), assistant(turn 1), user(deadline reminder), assistant(turn 2)
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    const deadlineUser = result.messages[2] as { content: string };
    expect(deadlineUser.content).toContain("time's up");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/revival/rebuild-messages.test.ts -t "deadline grace"`
Expected: FAIL — current implementation only handles `user_message` events on tool_result turns.

- [ ] **Step 3: Implement deadline-grace path**

Edit `src/revival/rebuild-messages.ts`. Restructure the turn loop so that a turn with a `user_message` event and **no** `tool_result` group emits the user message standalone (deadline-grace pattern, where the user message precedes the assistant response):

```typescript
for (const turn of turnNumbers) {
  const turnEvents = events.filter((e) => e.turn === turn);
  const llmResp = turnEvents.find((e) => e.type === "llm_response");
  const toolResultEvts = turnEvents.filter((e) => e.type === "tool_result");
  const toolCallEvts = turnEvents.filter((e) => e.type === "tool_call");
  const userMsg = turnEvents.find((e) => e.type === "user_message");

  // Grace turn: a user_message at this turn with NO tool_result group → standalone user turn (must come first, before the assistant)
  if (userMsg && toolResultEvts.length === 0) {
    messages.push(client.userMessage(String(userMsg.content ?? "")));
  }

  if (llmResp) {
    messages.push(llmResp.rawAssistantMessage);
  }

  // Tool-result-bearing turns: build via client.toolResultMessages, with optional reflection extraUserText
  if (toolResultEvts.length > 0) {
    const calls: ToolCall[] = toolCallEvts.map((tc) => ({
      id: String(tc.toolUseId),
      name: String(tc.name),
      arguments: (tc.arguments as Record<string, unknown>) ?? {},
    }));
    const results: ToolResult[] = toolResultEvts.map((tr) =>
      rebuildToolResult(tr, runDir, warnings),
    );
    const extraUserText = userMsg
      ? String(userMsg.content ?? "")
      : undefined;
    messages.push(...client.toolResultMessages(calls, results, extraUserText));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/revival/rebuild-messages.test.ts`
Expected: All PASS (reflection-checkpoint and happy-path tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/revival/rebuild-messages.ts test/revival/rebuild-messages.test.ts
git commit -m "$(cat <<'EOF'
revival: handle deadline-grace turn as standalone user message (PRI-1579)

A user_message at a turn with no tool_result group is the deadline-grace
reminder injected by runAgent's grace path. Emits as a standalone
user turn rather than weaving into a non-existent tool_result group.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 12: `rebuildMessages` — terminal-turn dangling tool_use stub synthesis

**Files:**
- Modify: `src/revival/rebuild-messages.ts`
- Modify: `test/revival/rebuild-messages.test.ts`

When the final assistant turn has `tool_use` blocks with no matching `tool_result` (e.g., `report_result` terminated the run, or `report_with_other_tools_dropped` fired), the Anthropic API rejects the request. Synthesize a stub user turn with `tool_result` blocks for each dangling `tool_use_id`.

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe("rebuildMessages — terminal tool_use stub", () => {
  test("synthesizes a tool_result user turn for report_result on the final assistant message", () => {
    const dir = makeRunDir([
      { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "web", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 0, toolTimeoutMs: 30000, contextTreeBytes: 0 },
      { type: "system_prompt", content: "sys" },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "Done.",
        thinking: [], toolCalls: [{ id: "rep1", name: "report_result", arguments: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } }], usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [
          { type: "text", text: "Done." },
          { type: "tool_use", id: "rep1", name: "report_result", input: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } },
        ]},
      },
      { type: "run_end", status: "pass", summary: "ok", reasoning: "ok", observationCount: 0, observations: [], durationMs: 100, usage: { inputTokens: 10, outputTokens: 5, turns: 1 } },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const last = result.messages[result.messages.length - 1] as {
      role: string;
      content: Array<{ type: string; tool_use_id?: string; content?: string }>;
    };
    expect(last.role).toBe("user");
    expect(last.content[0].type).toBe("tool_result");
    expect(last.content[0].tool_use_id).toBe("rep1");
    expect(last.content[0].content).toContain("revival");
  });

  test("synthesizes stubs for multiple unmatched tool_use blocks (report_with_other_tools_dropped)", () => {
    const dir = makeRunDir([
      { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "web", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 0, toolTimeoutMs: 30000, contextTreeBytes: 0 },
      { type: "system_prompt", content: "sys" },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "",
        thinking: [], toolCalls: [
          { id: "c1", name: "click", arguments: {} },
          { id: "rep1", name: "report_result", arguments: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } },
        ], usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [
          { type: "tool_use", id: "c1", name: "click", input: {} },
          { type: "tool_use", id: "rep1", name: "report_result", input: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } },
        ]},
      },
      // No tool_call/tool_result events because the agent loop dropped them when report_result fired
      { type: "event", name: "report_with_other_tools_dropped", dropped: ["click"] },
      { type: "run_end", status: "pass", summary: "ok", reasoning: "ok", observationCount: 0, observations: [], durationMs: 100, usage: { inputTokens: 10, outputTokens: 5, turns: 1 } },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const last = result.messages[result.messages.length - 1] as {
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    };
    const stubIds = last.content.map((b) => b.tool_use_id).sort();
    expect(stubIds).toEqual(["c1", "rep1"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/revival/rebuild-messages.test.ts -t "terminal tool_use"`
Expected: Two FAILs.

- [ ] **Step 3: Implement stub synthesis**

Edit `src/revival/rebuild-messages.ts`. After the turn loop completes, before returning, scan the *raw* `llm_response` events (not the rebuilt messages — those are already in provider-native shape, which differs per provider) for the final response's `toolCalls`. Any `tool_use_id` in that list without a matching `tool_result` event needs a synthesized stub, emitted through `client.toolResultMessages` so the shape is provider-native:

```typescript
// Terminal-turn stub synthesis (spec §"Terminal-turn handling").
// Source of truth is the llm_response events, not the rebuilt messages —
// the raw events are provider-neutral, while the rebuilt assistant
// messages are in provider-native shape (Anthropic content blocks vs
// OpenAI tool_calls).
const includedLlmResponses = events.filter(
  (e) => e.type === "llm_response" && (e.turn as number) <= cutoff,
);
const finalLlmResp = includedLlmResponses[includedLlmResponses.length - 1];
if (finalLlmResp) {
  const finalCalls = (finalLlmResp.toolCalls as ToolCall[]) ?? [];
  if (finalCalls.length > 0) {
    // Ids that were actually executed (have a matching tool_result event)
    const executedIds = new Set(
      events
        .filter(
          (e) =>
            e.type === "tool_result" &&
            (e.turn as number) === (finalLlmResp.turn as number),
        )
        .map((e) => String(e.toolUseId)),
    );
    const unmatched = finalCalls.filter((c) => !executedIds.has(c.id));
    if (unmatched.length > 0) {
      const stubResults: ToolResult[] = unmatched.map(() => ({
        text: "[revival: tool was not executed during the original run]",
      }));
      messages.push(...client.toolResultMessages(unmatched, stubResults));
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/revival/rebuild-messages.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/revival/rebuild-messages.ts test/revival/rebuild-messages.test.ts
git commit -m "$(cat <<'EOF'
revival: synthesize stub tool_result blocks for terminal tool_use (PRI-1579)

When a run ends on report_result (or report_with_other_tools_dropped),
the final assistant message has tool_use blocks with no matching
tool_result. Anthropic's API rejects that shape. We synthesize stub
user-turn tool_result blocks so the operator's next question lands as
the following user turn naturally.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 13: `rebuildMessages` — old-run fallback (no `tool_definitions` event)

**Files:**
- Modify: `src/revival/rebuild-messages.ts`
- Modify: `test/revival/rebuild-messages.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe("rebuildMessages — old-run fallback", () => {
  test("falls back to live adapter.toolDefinitions() + REPORT_TOOL with a drift warning", () => {
    const dir = makeRunDir([
      { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "web", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 0, toolTimeoutMs: 30000, contextTreeBytes: 0 },
      { type: "system_prompt", content: "sys" },
      // No tool_definitions event — old run
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "end_turn", text: "hi",
        thinking: [], toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    // Adapter tools (web) + REPORT_TOOL should be present
    const toolNames = result.toolDefs.map((t) => t.name);
    expect(toolNames).toContain("report_result");
    // At least one web-adapter tool — every adapter has multiple
    expect(toolNames.length).toBeGreaterThan(1);
    expect(result.warnings.some((w) => w.toLowerCase().includes("drift"))).toBe(true);
    expect(result.systemPrompt).toContain("fallback");
  });

  test("errors with a clear message when the recorded adapter is no longer registered", () => {
    const dir = makeRunDir([
      { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "nonexistent-adapter", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 0, toolTimeoutMs: 30000, contextTreeBytes: 0 },
      { type: "system_prompt", content: "sys" },
      { type: "user_message", turn: 0, content: "go" },
    ]);
    cleanups.push(dir);

    expect(() => rebuildMessages(dir, makeFakeAnthropicClient())).toThrow(/adapter.*not registered|no longer/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/revival/rebuild-messages.test.ts -t "old-run fallback"`
Expected: FAILs.

- [ ] **Step 3: Implement the fallback**

Edit `src/revival/rebuild-messages.ts`. We need a way to look up `adapter.toolDefinitions()` by name. The adapter registry lives at `src/adapters/`. There isn't (yet) a public registry-by-name function. Add one.

First, **export `REPORT_TOOL` from `src/agent/agent.ts`** (it's currently a module-local const) so the registry can reuse the live definition. Find `const REPORT_TOOL: ToolDefinition = {` near line 81 and change to `export const REPORT_TOOL: ToolDefinition = {`. No dep cycle: `agent.ts` does not import anything from `src/revival/` or `src/adapters/registry`.

Then create `src/adapters/registry.ts` (new file):

```typescript
import type { ToolDefinition } from "../models/provider";
import { WebAdapter } from "./web/adapter";
import { CLIAdapter } from "./cli/adapter";
import { TUIAdapter } from "./tui/adapter";

/**
 * Look up an adapter's tool definitions by recorded adapter name.
 * Throws if the name is unknown.
 *
 * `toolDefinitions()` is pure on a default-constructed adapter (see
 * the comment on `selectAdapter` in src/cli/show-prompt.ts) — we use
 * the same `{ contextRoot }`-only construction pattern.
 */
export function getAdapterToolDefinitionsByName(name: string): ToolDefinition[] {
  switch (name) {
    case "web":
      return new WebAdapter({ contextRoot: undefined }).toolDefinitions();
    case "cli":
      return new CLIAdapter({ contextRoot: undefined }).toolDefinitions();
    case "tui":
      return new TUIAdapter({ contextRoot: undefined }).toolDefinitions();
    default:
      throw new Error(
        `Adapter "${name}" is not registered. The recorded run used an adapter that no longer exists in this build.`,
      );
  }
}
```

Now in `src/revival/rebuild-messages.ts`, add the import and replace the `toolDefs` initialization:

```typescript
import { getAdapterToolDefinitionsByName } from "../adapters/registry";
import { REPORT_TOOL } from "../agent/agent";

// ... within rebuildMessages, after we've discovered adapterName and read toolDefsEvt ...

let toolDefs: ToolDefinition[];
const fallback = !toolDefsEvt;
if (toolDefsEvt) {
  toolDefs = toolDefsEvt.tools as ToolDefinition[];
} else {
  toolDefs = [...getAdapterToolDefinitionsByName(adapterName), REPORT_TOOL];
  warnings.push(
    "No tool_definitions event in this run's run.jsonl (old format); reconstructed from current adapter code. Schemas may have drifted.",
  );
}

const systemPrompt =
  systemPromptBody + buildRevivalAddendum(toolDefs, { fallback });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/revival/rebuild-messages.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/registry.ts src/revival/rebuild-messages.ts test/revival/rebuild-messages.test.ts
git commit -m "$(cat <<'EOF'
revival: fallback to live adapter tools for old runs without the event (PRI-1579)

Old runs (no tool_definitions event) get a fallback: live
adapter.toolDefinitions() + REPORT_TOOL, with a drift warning. If the
recorded adapter name is no longer registered, error clearly instead
of silently listing no tools.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 14: `rebuildMessages` — `--turn N` cutoff and range checks

**Files:**
- Modify: `src/revival/rebuild-messages.ts`
- Modify: `test/revival/rebuild-messages.test.ts`

The cutoff logic is partly already implemented from Task 7. This task locks it in with tests for boundary cases.

- [ ] **Step 1: Write the failing test**

Append:

```typescript
describe("rebuildMessages — --turn cutoff", () => {
  const events3turn = [
    { type: "run_start", runId: "r1", cardId: "c1", model: "claude-sonnet-4-6", adapter: "web", provider: "anthropic", target: "x", budgetMs: 60000, reflectionInterval: 0, toolTimeoutMs: 30000, contextTreeBytes: 0 },
    { type: "system_prompt", content: "sys" },
    { type: "user_message", turn: 0, content: "go" },
    { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
      toolCalls: [{ id: "t1", name: "click", arguments: {} }], usage: { inputTokens: 10, outputTokens: 5 },
      rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "click", input: {} }] } },
    { type: "tool_call", turn: 1, toolUseId: "t1", name: "click", arguments: {} },
    { type: "tool_result", turn: 1, toolUseId: "t1", name: "click", durationMs: 5, text: "ok", error: false },
    { type: "llm_response", turn: 2, stopReason: "tool_use", text: "", thinking: [],
      toolCalls: [{ id: "t2", name: "click", arguments: {} }], usage: { inputTokens: 10, outputTokens: 5 },
      rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "click", input: {} }] } },
    { type: "tool_call", turn: 2, toolUseId: "t2", name: "click", arguments: {} },
    { type: "tool_result", turn: 2, toolUseId: "t2", name: "click", durationMs: 5, text: "ok", error: false },
    { type: "llm_response", turn: 3, stopReason: "tool_use", text: "", thinking: [],
      toolCalls: [{ id: "rep1", name: "report_result", arguments: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } }], usage: { inputTokens: 10, outputTokens: 5 },
      rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "rep1", name: "report_result", input: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } }] } },
    { type: "run_end", status: "pass", summary: "ok", reasoning: "ok", observationCount: 0, observations: [], durationMs: 100, usage: { inputTokens: 10, outputTokens: 5, turns: 3 } },
  ];

  test("--turn 0 yields only the initial user message", () => {
    const dir = makeRunDir(events3turn);
    cleanups.push(dir);
    const result = rebuildMessages(dir, makeFakeAnthropicClient(), 0);
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as { role: string }).role).toBe("user");
  });

  test("--turn 1 includes turn 1 assistant + tool result", () => {
    const dir = makeRunDir(events3turn);
    cleanups.push(dir);
    const result = rebuildMessages(dir, makeFakeAnthropicClient(), 1);
    const roles = result.messages.map((m) => (m as { role?: string }).role);
    // user(0) + assistant(1) + user(tool_result for 1)
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  test("--turn 2 includes turns 1 and 2 but NOT turn 3 report_result", () => {
    const dir = makeRunDir(events3turn);
    cleanups.push(dir);
    const result = rebuildMessages(dir, makeFakeAnthropicClient(), 2);
    // No stub for report_result since report_result is on turn 3, excluded
    const last = result.messages[result.messages.length - 1] as { role: string; content: unknown };
    expect(last.role).toBe("user"); // tool_result for turn 2
    // The final assistant turn included is turn 2's
    const assistantTurns = result.messages.filter(
      (m) => (m as { role?: string }).role === "assistant",
    );
    expect(assistantTurns).toHaveLength(2);
  });

  test("--turn out of range errors clearly", () => {
    const dir = makeRunDir(events3turn);
    cleanups.push(dir);
    expect(() => rebuildMessages(dir, makeFakeAnthropicClient(), 99)).toThrow(/out of range|ended at turn 3/);
  });
});
```

- [ ] **Step 2: Run tests — they are partly characterization tests**

The cutoff filtering was already implemented in Task 7. These tests *lock in* the contract — some will pass on the first run (characterizing existing behavior) and some may catch boundary bugs (off-by-one on `--turn 0`, range check ordering). That's intentional: we're encoding the spec's boundary semantics as tests so future changes can't regress them.

Run: `bun test test/revival/rebuild-messages.test.ts -t "--turn cutoff"`

- [ ] **Step 3: Fix any boundary bugs that surface**

Read each failure carefully and patch `rebuildMessages` to match. Likely bugs to look for:
- Off-by-one when filtering turn numbers
- `--turn 0` accidentally including a turn-1 assistant turn
- Range check fires before discovering `lastTurn`

- [ ] **Step 4: Run all tests in this file**

Run: `bun test test/revival/rebuild-messages.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/revival/rebuild-messages.ts test/revival/rebuild-messages.test.ts
git commit -m "$(cat <<'EOF'
revival: lock in --turn cutoff semantics with boundary tests (PRI-1579)

--turn 0 → initial user only. --turn N → through turn N inclusive.
--turn past last → clear error. Spec semantics are now test-anchored.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 15: Parse `ask` CLI args

**Files:**
- Modify: `src/cli/args.ts`
- Test: `test/cli/ask.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cli/ask.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { parseArgs } from "../../src/cli/args";

describe("parseArgs ask", () => {
  test("parses positional runId", () => {
    const r = parseArgs(["bun", "gauntlet", "ask", "login-001_20260101T000000Z_abcd"]);
    expect(r.command).toBe("ask");
    expect((r as { runId: string }).runId).toBe("login-001_20260101T000000Z_abcd");
  });

  test("parses --turn", () => {
    const r = parseArgs(["bun", "gauntlet", "ask", "rid", "--turn", "5"]);
    expect((r as { upToTurn?: number }).upToTurn).toBe(5);
  });

  test("parses --model", () => {
    const r = parseArgs(["bun", "gauntlet", "ask", "rid", "--model", "claude-opus-4-7"]);
    expect((r as { modelOverride?: string }).modelOverride).toBe("claude-opus-4-7");
  });

  test("rejects unknown flags", () => {
    expect(() => parseArgs(["bun", "gauntlet", "ask", "rid", "--bogus", "x"])).toThrow(/Unknown flag/);
  });

  test("requires a runId positional", () => {
    expect(() => parseArgs(["bun", "gauntlet", "ask"])).toThrow(/runId|Usage/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/ask.test.ts`
Expected: FAIL — unknown command.

- [ ] **Step 3: Add `AskArgs` and `parseAskArgs`**

Edit `src/cli/args.ts`. Add the type to the existing types:

```typescript
export interface AskArgs {
  command: "ask";
  runId: string;
  upToTurn?: number;
  modelOverride?: string;
  cli: CliArgsInput;
}
```

Add `AskArgs` to the union:

```typescript
export type ParsedArgs = RunArgs | BatchArgs | ValidateArgs | FanoutArgs | ServeArgs | ConfigArgs | AskArgs;
```

Add the `"ask"` case in `parseArgs`:

```typescript
case "ask":
  return parseAskArgs(args.slice(1));
```

Add `parseAskArgs` near `parseConfigArgs`. Two gotchas the spec-review caught: `rejectUnknownFlags` takes a `Set<string>` (not an array), and `parseFlags` returns `flags.model` as a `string[]` because `--model` is special-cased to accumulate. Handle both:

```typescript
const ASK_ALLOWED = new Set(["turn", "model", "project-dir"]);

function parseAskArgs(args: string[]): AskArgs {
  const positional = extractPositional(args);
  if (!positional) {
    throw new Error("Missing runId\n\nUsage: gauntlet ask <runId> [--turn N] [--model MODEL]");
  }
  const flags = parseFlags(args);
  rejectUnknownFlags(flags, ASK_ALLOWED, "ask");
  // parseFlags accumulates --model into flags.model (string[])
  const modelOverride =
    Array.isArray(flags.model) && flags.model.length > 0
      ? flags.model[0]
      : undefined;
  return {
    command: "ask",
    runId: positional,
    upToTurn: parseIntFlag(flags.turn, "--turn"),
    modelOverride,
    cli: { projectRoot: flags["project-dir"] },
  };
}
```

(`extractPositional`, `parseFlags`, `rejectUnknownFlags`, `parseIntFlag` are already in this file — confirm via grep.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/cli/ask.test.ts`
Expected: All PASS.

- [ ] **Step 5: Update `usage()` text**

In the same file, find the `usage()` function and add a line for `ask`:

```
  gauntlet ask <runId> [--turn N] [--model MODEL]    Chat with the agent from a completed run.
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/args.ts test/cli/ask.test.ts
git commit -m "$(cat <<'EOF'
cli: parse ask subcommand args (PRI-1579)

Positional runId, optional --turn and --model. Mirrors the pattern
used by run/batch/etc.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 16: Build the `ask` REPL (initial wiring + provenance header)

**Files:**
- Create: `src/cli/ask.ts`
- Modify: `src/index.ts`

This task brings together everything: load run, rebuild messages, open REPL, ask one question, exit. Subsequent tasks add polish (usage line, multi-turn, error handling).

- [ ] **Step 1: Implement the basic REPL**

Create `src/cli/ask.ts`:

```typescript
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import type { AskArgs } from "./args";
import type { AppConfig } from "../config";
import type { LLMClient } from "../models/provider";
import { rebuildMessages, ANSWER_TOOL, extractAnswer } from "../revival";
import { createClient, UnknownModelProviderError } from "../models/resolve";

export async function ask(args: AskArgs, config: AppConfig): Promise<number> {
  const runDir = resolve(config.projectRoot, ".gauntlet", "results", args.runId);
  if (!existsSync(runDir)) {
    console.error(`Run not found: ${args.runId} (looked in ${runDir})`);
    return 1;
  }
  const jsonlPath = resolve(runDir, "run.jsonl");
  if (!existsSync(jsonlPath)) {
    console.error(`Run ${args.runId} has no run.jsonl; cannot revive`);
    return 1;
  }

  // Build the live client first so rebuildMessages can use its
  // userMessage / toolResultMessages shape (provider-native for both
  // Anthropic and OpenAI). The pinned-model choice happens here.
  const recordedModelId = peekRecordedModel(runDir);
  const modelToUse = args.modelOverride ?? recordedModelId;
  let client: LLMClient;
  try {
    client = createClient(modelToUse);
  } catch (err) {
    if (err instanceof UnknownModelProviderError) {
      console.error(
        `Run ${args.runId} was recorded against model ${recordedModelId}, which is no longer available. ` +
        `To revive against a different model, pass --model <model-id>. ` +
        `Note that the answers will be from a different model than the one that produced the original run.`,
      );
      return 1;
    }
    throw err;
  }

  const rebuilt = rebuildMessages(runDir, client, args.upToTurn);

  // Header — recorded date comes from the run_start event's ts
  const recordedDate = peekRecordedDate(runDir);
  const overrideNote =
    args.modelOverride && args.modelOverride !== rebuilt.modelId
      ? ` (override: ${args.modelOverride}; recorded was ${rebuilt.modelId})`
      : "";
  console.log(
    `Revival of run ${args.runId} against model ${modelToUse}${overrideNote} (recorded ${recordedDate})`,
  );
  console.log(`Adapter: ${rebuilt.adapterName}`);
  for (const w of rebuilt.warnings) console.log(`  ! ${w}`);
  console.log(`Type your question. Ctrl-D, Ctrl-C, or :quit to exit.`);
  console.log("");

  const messages = [...rebuilt.messages];

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "? " });
  rl.prompt();

  return new Promise<number>((resolveExit) => {
    rl.on("line", async (line) => {
      const q = line.trim();
      if (q === ":quit" || q === "") {
        rl.close();
        return;
      }
      messages.push(client.userMessage(q));
      try {
        const response = await client.chat(messages, [ANSWER_TOOL], rebuilt.systemPrompt);
        const extracted = extractAnswer(response.toolCalls, response.text);
        const tag = extracted.kind === "unstructured" ? " (unstructured)" : "";
        console.log("");
        console.log(extracted.text + tag);
        console.log(
          `  [tokens: ${response.usage.inputTokens} in / ${response.usage.outputTokens} out` +
            (response.usage.cacheReadInputTokens
              ? `; ${response.usage.cacheReadInputTokens} cached`
              : "") +
            `]`,
        );
        console.log("");
        // Multi-turn: keep the assistant message in `messages`, and if
        // the model used the answer tool, append a matching tool_result
        // via the client (provider-native shape) so the next turn is valid.
        messages.push(response.rawAssistantMessage);
        const answerCall = response.toolCalls.find((tc) => tc.name === "answer");
        if (answerCall) {
          messages.push(
            ...client.toolResultMessages(
              [answerCall],
              [{ text: "" }],
            ),
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`API error: ${msg}`);
      }
      rl.prompt();
    });
    rl.on("close", () => {
      console.log("");
      resolveExit(0);
    });
    // Ctrl-C: close cleanly
    rl.on("SIGINT", () => {
      rl.close();
    });
  });
}

/**
 * Peek at the recorded model from run.jsonl without doing a full rebuild.
 * Used before client construction so we can show a helpful error if the
 * model is no longer available.
 */
function peekRecordedModel(runDir: string): string {
  const text = readFileSync(resolve(runDir, "run.jsonl"), "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const evt = JSON.parse(line) as { type?: string; model?: string };
    if (evt.type === "run_start") return String(evt.model ?? "");
  }
  return "";
}

function peekRecordedDate(runDir: string): string {
  const text = readFileSync(resolve(runDir, "run.jsonl"), "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const evt = JSON.parse(line) as { type?: string; ts?: string };
    if (evt.type === "run_start") return String(evt.ts ?? "unknown date");
  }
  return "unknown date";
}
```

- [ ] **Step 2: Wire into `src/index.ts`**

Edit `src/index.ts`. After the existing `case "config"` (or wherever fits), add:

```typescript
case "serve": {
  // ... existing ...
}
case "ask": {
  const config = await loadConfigOrThrow(args.cli);
  await requireLlmCapableOrThrow(config);
  const { ask } = await import("./cli/ask");
  return ask(args, config);
}
```

(Confirm the surrounding switch shape. Imports use dynamic `await import` like other branches.)

- [ ] **Step 3: Manual smoke test**

After Task 19's integration test fixtures are in place, this can be a sanity-check. For now, ensure the file compiles:

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/ask.ts src/index.ts
git commit -m "$(cat <<'EOF'
cli: ask subcommand — load run, open REPL (PRI-1579)

Wires rebuildMessages + ANSWER_TOOL into a readline REPL. Header
prints provenance; warnings surface; Ctrl-D/Ctrl-C/:quit exits.
Subsequent commits add per-reply usage line and richer error handling.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 17: CLI tests for missing-run / missing-jsonl error paths

**Files:**
- Modify: `test/cli/ask.test.ts`

The REPL's happy path is exercised by the smoke test in Task 19, but the early-exit error paths (run not found, run.jsonl missing) deserve fast unit coverage.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli/ask.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ask } from "../../src/cli/ask";

describe("ask error paths", () => {
  test("returns 1 and logs when the run directory does not exist", async () => {
    const projRoot = mkdtempSync(join(tmpdir(), "gauntlet-ask-"));
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => { errors.push(String(msg)); };
    try {
      const code = await ask(
        { command: "ask", runId: "nonexistent_run", cli: {} },
        { projectRoot: projRoot } as never,
      );
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes("Run not found"))).toBe(true);
    } finally {
      console.error = origErr;
      rmSync(projRoot, { recursive: true, force: true });
    }
  });

  test("returns 1 and logs when the run directory exists but run.jsonl is missing", async () => {
    const projRoot = mkdtempSync(join(tmpdir(), "gauntlet-ask-"));
    mkdirSync(join(projRoot, ".gauntlet", "results", "empty_run"), { recursive: true });
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => { errors.push(String(msg)); };
    try {
      const code = await ask(
        { command: "ask", runId: "empty_run", cli: {} },
        { projectRoot: projRoot } as never,
      );
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes("no run.jsonl"))).toBe(true);
    } finally {
      console.error = origErr;
      rmSync(projRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests, ensure they pass**

Run: `bun test test/cli/ask.test.ts -t "error paths"`
Expected: PASS — these paths are already implemented in Task 16.

- [ ] **Step 3: Commit**

```bash
git add test/cli/ask.test.ts
git commit -m "$(cat <<'EOF'
cli: lock in ask error-path coverage (PRI-1579)

Missing-run and missing-jsonl paths get fast unit coverage. The
happy path is exercised by the smoke test.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 18: Update `docs/format.md`

**Files:**
- Modify: `docs/format.md`

- [ ] **Step 1: Document the new event and field**

Edit `docs/format.md`. In the comma-separated event list inside the `run.jsonl` section of the directory layout block, add `tool_definitions` between `system_prompt` and `user_message`. The result should read:

```
                       run_start, system_prompt, tool_definitions,
                       user_message, llm_request, llm_response (text, ...
```

After the event list and `run.jsonl` description, add a brief paragraph:

```
The `tool_definitions` event captures the full set of tool schemas
exposed to the agent — adapter tools plus `report_result` — so
post-hoc consumers (e.g. `gauntlet ask`) can faithfully tell the
revival model what was available during the original run.

The `tool_result` event optionally carries a `mediaType` string when
`image` is set, recording the image's media type so revival can
slot the bytes back into a provider-native image block without
guessing.
```

- [ ] **Step 2: Commit**

```bash
git add docs/format.md
git commit -m "$(cat <<'EOF'
docs(format): document tool_definitions event and tool_result mediaType (PRI-1579)

Companion to the recording-side changes for session revival.

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

---

## Task 19: Smoke-test against a real run

**Note:** Pemberton's review flagged that this is also where we verify the `--model` override path and OpenAI fidelity (if any team OpenAI-recorded runs exist). Do both.

**Files:**
- No code; manual verification.

- [ ] **Step 1: Generate a fresh run with the new code**

```bash
cd /Users/mw/Code/prime/gauntlet
bun run gauntlet run examples/tutorial/.gauntlet/stories/tutorial-01-page-loads.md --target http://localhost:3000
```

(Use whatever existing story card and target match the workstation's setup. The tutorial dir contains real stories.)

Wait for the run to finish. Note the runId from the output.

- [ ] **Step 2: Verify `tool_definitions` and `mediaType` are present**

```bash
grep -c '"type":"tool_definitions"' .gauntlet/results/<runId>/run.jsonl
# Expected: 1
grep -c '"mediaType"' .gauntlet/results/<runId>/run.jsonl
# Expected: >0 if the run produced any screenshots
```

- [ ] **Step 3: Run `gauntlet ask` against that run**

```bash
bun run gauntlet ask <runId>
```

At the `? ` prompt, ask:
- "Why did you click X on turn 3?" (substitute a real action you saw in the transcript)
- "What would have changed your verdict?"
- `:quit`

Expected: model produces coherent answers grounded in the recorded transcript. Header shows the recorded model. No files created in the run directory.

- [ ] **Step 4: Verify no writes back**

```bash
ls -la .gauntlet/results/<runId>/
# Expected: same mtime on every file as before the ask command ran
```

If anything changed, investigate before declaring done.

- [ ] **Step 5: Run the full check suite**

```bash
bun run check
```

Expected: typecheck, build, and test all PASS.

- [ ] **Step 6: Commit (only if you patched something during smoke testing)**

```bash
git add <whatever>
git commit -m "$(cat <<'EOF'
revival: smoke-test fixes (PRI-1579)

[describe what you found]

Co-Authored-By: Ianto@7f02be88 (Opus 4.7)
EOF
)"
```

If nothing needed patching, skip this commit.

---

## Final verification

After all tasks above pass, run the full suite one more time:

```bash
bun run check
```

If all green, the feature is ready to merge. Per project rule (no PRs), merge to main directly:

```bash
git checkout main
git pull
git merge --no-ff <feature-branch> -m "Merge: session revival (PRI-1579)"
git push
```

Then move PRI-1579 to In Review (NOT Done — terminal states are off-limits).

---

## Spec coverage map

For self-verification: every spec section should map to at least one task.

| Spec section | Task(s) |
|---|---|
| §"What it does" REPL flow | 16, 17 |
| §"Fidelity contract" — tools-as-prose | 5, 16 |
| §"Fidelity contract" — no extended thinking | (passive: don't enable it; task 16 confirms) |
| §"Model pinning" | 16 |
| §"The `answer` tool" + plain-text fallback | 4, 16 |
| §"How messages get rebuilt" — cutoff | 14 |
| §"How messages get rebuilt" — initial user | 7 |
| §"How messages get rebuilt" — assistant + tool_result | 7 |
| §"How messages get rebuilt" — image rehydration | 8 |
| §"How messages get rebuilt" — text/capture rehydration | 9 |
| §"How messages get rebuilt" — reflection weave | 10 |
| §"How messages get rebuilt" — grace-turn | 11 |
| §"Terminal-turn handling" | 12 |
| §"Required run.jsonl changes" — tool_definitions | 1, 3 |
| §"Required run.jsonl changes" — mediaType | 2 |
| §"Required run.jsonl changes" — fallback | 13 |
| §"Required run.jsonl changes" — adapter-not-registered error | 13 |
| §"Failure modes" | 16 (basic handling); refinements in plan-review |
| docs/format.md update | 18 |
| Integration verification | 19 |
