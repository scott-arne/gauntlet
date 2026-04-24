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
  test("renders full happy fixture", () => {
    const { events, expected } = loadFixture("happy");
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    for (const e of events) r.handle(e);
    r.close();
    expect(sink.out).toBe(expected);
  });

  test("renders failing tool call with error + hint lines", () => {
    const { events, expected } = loadFixture("failing-tool");
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    for (const e of events) r.handle(e);
    r.close();
    expect(sink.out).toBe(expected);
  });

  test("renders event (meta) line and run_error fatal panel", () => {
    const { events, expected } = loadFixture("fatal");
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    for (const e of events) r.handle(e);
    r.close();
    expect(sink.out).toBe(expected);
  });

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

  test("assistant text longer than columns is soft-wrapped at columns-4", () => {
    const longText = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 24 }); // effective wrap width: 20
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "run_start", runId: "r", cardId: "c", target: "t", provider: "a", model: "m", adapter: "cli", maxTurns: 1, toolTimeoutMs: 1, contextTreeBytes: 0 } as any);
    r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "llm_response", turn: 1, stopReason: "end_turn", text: longText, thinking: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, rawAssistantMessage: null } as any);
    r.close();
    const assistantBlock = sink.out.split("= assistant\n")[1] ?? "";
    const wrappedLines = assistantBlock.split("\n").filter((l) => l.startsWith("    ") && l.trim().length > 0);
    expect(wrappedLines.length).toBeGreaterThan(1); // actually wrapped into multiple lines
    for (const line of wrappedLines) {
      const content = line.slice(4); // strip the "    " indent
      expect(content.length).toBeLessThanOrEqual(20);
    }
  });

  test("pendingRewrite is invalidated if a non-result event interleaves (defensive)", () => {
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: true, columns: 100 });
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "tool_call", turn: 1, toolUseId: "t1", name: "click", arguments: { selector: ".x" } } as any);
    // An unexpected event arrives between call and result
    r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "event", name: "something_weird", note: "interleaved" } as any);
    r.handle({ eventId: 3, parentEventId: 2, ts: "t", type: "tool_result", turn: 1, toolUseId: "t1", name: "click", durationMs: 420, text: "", error: false } as any);
    r.close();
    // The cursor-up + erase sequence MUST NOT fire — it would have erased the meta line.
    expect(sink.out).not.toContain("\x1b[1A\x1b[2K");
    // Result still arrives, via the two-line fallback (↳ + timing).
    expect(sink.out).toContain("↳");
    expect(sink.out).toContain("420ms");
  });

  test("consecutive tool calls render without a blank line between them", () => {
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "tool_call", turn: 1, toolUseId: "t1", name: "screenshot", arguments: {} } as any);
    r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "tool_result", turn: 1, toolUseId: "t1", name: "screenshot", durationMs: 309, text: "", image: "screenshots/001.png", error: false } as any);
    r.handle({ eventId: 3, parentEventId: 2, ts: "t", type: "tool_call", turn: 1, toolUseId: "t2", name: "read", arguments: { path: "x.md" } } as any);
    r.handle({ eventId: 4, parentEventId: 3, ts: "t", type: "tool_result", turn: 1, toolUseId: "t2", name: "read", durationMs: 0, text: "", error: false } as any);
    r.close();
    // No blank line between the first tool_result's evidence arrow and the next tool_call.
    expect(sink.out).toContain("→ screenshots/001.png\n  ▸ read");
    // A trailing blank is still deferred after the final tool_result; the next non-tool event would flush it.
    const afterFinal = sink.out.split("↳ ✓ 0ms\n").at(-1) ?? "";
    expect(afterFinal).toBe("");
  });

  test("deferred blank flushes before a turn header following a tool_result", () => {
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "tool_call", turn: 1, toolUseId: "t1", name: "screenshot", arguments: {} } as any);
    r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "tool_result", turn: 1, toolUseId: "t1", name: "screenshot", durationMs: 309, text: "", image: "screenshots/001.png", error: false } as any);
    r.handle({ eventId: 3, parentEventId: 2, ts: "t", type: "llm_response", turn: 2, stopReason: "end_turn", text: "ok", thinking: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, rawAssistantMessage: null } as any);
    r.close();
    // Blank line separates the tool_result from the next Turn header.
    expect(sink.out).toContain("→ screenshots/001.png\n\n▎ Turn 2");
  });
});
