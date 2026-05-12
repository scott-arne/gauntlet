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
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "run_start", runId: "r", cardId: "c", target: "t", provider: "a", model: "claude-sonnet-4-6", adapter: "web", budgetMs: 300_000, maxStuckRetries: 5, toolTimeoutMs: 1, contextTreeBytes: 0 } as any);
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
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "run_start", runId: "r", cardId: "c", target: "t", provider: "a", model: "claude-sonnet-4-6", adapter: "web", budgetMs: 300_000, maxStuckRetries: 5, toolTimeoutMs: 1, contextTreeBytes: 0 } as any);
    r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "llm_request", turn: 1, messageCount: 1 } as any);
    expect(sink.out).not.toContain("waiting for model");
    r.close();
  });

  test("assistant text longer than columns is soft-wrapped under the » glyph", () => {
    const longText = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 24 }); // effective wrap width: 22
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "run_start", runId: "r", cardId: "c", target: "t", provider: "a", model: "m", adapter: "cli", budgetMs: 300_000, maxStuckRetries: 5, toolTimeoutMs: 1, contextTreeBytes: 0 } as any);
    r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "llm_response", turn: 1, stopReason: "end_turn", text: longText, thinking: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, rawAssistantMessage: null } as any);
    r.close();
    // First line carries a leading `»`; wrap continuations indent to 2 spaces.
    expect(sink.out).toMatch(/^» alpha/m);
    const continuations = sink.out.split("\n").filter(
      (l) => l.startsWith("  ") && l.trim().length > 0 && !l.includes("»"),
    );
    expect(continuations.length).toBeGreaterThan(0);
    for (const line of continuations) {
      // Wrap budget is columns - 2 (=22). Continuations should respect it.
      const content = line.slice(2);
      expect(content.length).toBeLessThanOrEqual(22);
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
  });

  test("renders text-only tool_result as a one-line snippet (last non-empty line)", () => {
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "tool_call", turn: 1, toolUseId: "t1", name: "read_output", arguments: {} } as any);
    r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "tool_result", turn: 1, toolUseId: "t1", name: "read_output", durationMs: 0, text: "leading banner\npackage name: (scratch-npm) ", error: false } as any);
    r.close();
    expect(sink.out).toContain("↳ package name: (scratch-npm)");
    // Banner line above the prompt is not surfaced (only the active prompt is shown).
    expect(sink.out).not.toContain("leading banner");
  });

  test("does not render snippet for non-read_output text tools (file read, type, press)", () => {
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "tool_call", turn: 1, toolUseId: "t1", name: "read", arguments: { path: "x.md" } } as any);
    r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "tool_result", turn: 1, toolUseId: "t1", name: "read", durationMs: 2, text: "# Title\n\n- last bullet\n", error: false } as any);
    r.handle({ eventId: 3, parentEventId: 2, ts: "t", type: "tool_call", turn: 1, toolUseId: "t2", name: "type", arguments: { text: "x" } } as any);
    r.handle({ eventId: 4, parentEventId: 3, ts: "t", type: "tool_result", turn: 1, toolUseId: "t2", name: "type", durationMs: 0, text: "typed", error: false } as any);
    r.handle({ eventId: 5, parentEventId: 4, ts: "t", type: "tool_call", turn: 1, toolUseId: "t3", name: "press", arguments: { key: "Enter" } } as any);
    r.handle({ eventId: 6, parentEventId: 5, ts: "t", type: "tool_result", turn: 1, toolUseId: "t3", name: "press", durationMs: 0, text: "pressed", error: false } as any);
    r.close();
    // No body snippets — read's last bullet, type's "typed", press's "pressed"
    // should all be suppressed (only `read_output` renders an inline snippet).
    expect(sink.out).not.toContain("last bullet");
    expect(sink.out).not.toContain("↳ typed");
    expect(sink.out).not.toContain("↳ pressed");
    // Sub-50ms successful timings are suppressed entirely under the new rules.
    expect(sink.out).not.toContain("↳ ✓");
  });

  test("truncates very long single-line read_output result text with ellipsis", () => {
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 40 });
    const long = "x".repeat(200);
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "tool_call", turn: 1, toolUseId: "t1", name: "read_output", arguments: {} } as any);
    r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "tool_result", turn: 1, toolUseId: "t1", name: "read_output", durationMs: 0, text: long, error: false } as any);
    r.close();
    expect(sink.out).toContain("…");
    // Snippet line is bounded by columns (with margin for indent + glyph).
    const snippetLine = sink.out.split("\n").find((l) => l.includes("↳ x")) ?? "";
    expect(snippetLine.length).toBeLessThanOrEqual(40);
  });

  test("section header carries a · t<N> turn marker", () => {
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "llm_response", turn: 5, stopReason: "end_turn", text: "Accept the default version.", thinking: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, rawAssistantMessage: null } as any);
    r.close();
    expect(sink.out).toContain("» Accept the default version. · t5");
  });

  test("blank line separates one section from the next", () => {
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "tool_call", turn: 1, toolUseId: "t1", name: "screenshot", arguments: {} } as any);
    r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "tool_result", turn: 1, toolUseId: "t1", name: "screenshot", durationMs: 309, text: "", image: "screenshots/001.png", error: false } as any);
    r.handle({ eventId: 3, parentEventId: 2, ts: "t", type: "llm_response", turn: 2, stopReason: "end_turn", text: "ok", thinking: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, rawAssistantMessage: null } as any);
    r.close();
    // One blank between the previous tools and the next section header — never two.
    expect(sink.out).toMatch(/→ screenshots\/001\.png\n\n» ok · t2/);
    expect(sink.out).not.toMatch(/→ screenshots\/001\.png\n\n\n/);
  });

  test("tool-only turn produces no header, dissolves into preceding section", () => {
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    // Section: utterance + 1 tool
    r.handle({ eventId: 1, parentEventId: 0, ts: "t", type: "llm_response", turn: 1, stopReason: "tool_use", text: "Run the thing.", thinking: [], toolCalls: [{ id: "t1", name: "press", arguments: { key: "Enter" } }], usage: { inputTokens: 0, outputTokens: 0 }, rawAssistantMessage: null } as any);
    r.handle({ eventId: 2, parentEventId: 1, ts: "t", type: "tool_call", turn: 1, toolUseId: "t1", name: "press", arguments: { key: "Enter" } } as any);
    r.handle({ eventId: 3, parentEventId: 2, ts: "t", type: "tool_result", turn: 1, toolUseId: "t1", name: "press", durationMs: 0, text: "pressed", error: false } as any);
    // Tool-only turn 2: no utterance, just another tool
    r.handle({ eventId: 4, parentEventId: 3, ts: "t", type: "llm_response", turn: 2, stopReason: "tool_use", text: "", thinking: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, rawAssistantMessage: null } as any);
    r.handle({ eventId: 5, parentEventId: 4, ts: "t", type: "tool_call", turn: 2, toolUseId: "t2", name: "read_output", arguments: {} } as any);
    r.handle({ eventId: 6, parentEventId: 5, ts: "t", type: "tool_result", turn: 2, toolUseId: "t2", name: "read_output", durationMs: 0, text: "version: (1.0.0) ", error: false } as any);
    r.close();
    // Only one section header — the utterance from turn 1.
    const headers = sink.out.match(/^» /gm) ?? [];
    expect(headers.length).toBe(1);
    // No "· t2" anywhere — the tool-only turn has no header to put it on.
    expect(sink.out).not.toContain("· t2");
    // The two tools pack contiguously under the single header.
    expect(sink.out).toMatch(/▸ press Enter\n  ▸ read_output/);
  });

  test("anomaly event line uses compact summary for known event families", () => {
    const sink = collect();
    const r = new PrettyRenderer(sink, { color: false, columns: 100 });
    r.handle({
      eventId: 1, parentEventId: 0, ts: "t", type: "event", name: "install_cookies_ok",
      path: "profiles/fred/cookies.yaml", accepted: 1, rejected: 0,
      cookies: [{ name: "session", domain: null, valueLength: 4 }],
    } as any);
    r.close();
    expect(sink.out).toContain("install_cookies_ok");
    expect(sink.out).toContain("accepted 1");
    expect(sink.out).toContain("session");
    // The raw cookie object is NOT dumped inline.
    expect(sink.out).not.toContain("valueLength");
    expect(sink.out).not.toContain("[{");
  });
});
