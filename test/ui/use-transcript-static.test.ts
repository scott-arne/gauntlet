import { describe, test, expect } from "bun:test";
import {
  parseJsonl,
  reduceTranscript,
} from "../../ui/src/lib/transcript";
import { parseTranscriptFromStaticPayload } from "../../ui/src/hooks/useTranscript";

// Minimal run_start + run_end jsonl for static-mode testing
const MINIMAL_JSONL = [
  JSON.stringify({
    eventId: 1,
    parentEventId: 0,
    ts: "2024-01-01T00:00:00Z",
    type: "run_start",
    runId: "card-001_20240101T000000Z_abc",
    cardId: "card-001",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    adapter: "web",
    budgetMs: 60000,
    toolTimeoutMs: 10000,
    contextTreeBytes: 0,
  }),
  JSON.stringify({
    eventId: 2,
    parentEventId: 1,
    ts: "2024-01-01T00:00:01Z",
    type: "run_end",
    status: "pass",
    summary: "Passed",
    reasoning: "Everything worked",
    observationCount: 0,
    durationMs: 1000,
    usage: { inputTokens: 10, outputTokens: 5, turns: 1 },
  }),
].join("\n");

describe("parseTranscriptFromStaticPayload", () => {
  test("parses runJsonl into a TranscriptModel without calling the API", () => {
    const model = parseTranscriptFromStaticPayload(MINIMAL_JSONL);
    expect(model).not.toBeNull();
    expect(model?.runStart?.cardId).toBe("card-001");
    expect(model?.runEnd?.status).toBe("pass");
  });

  test("returns null for empty string", () => {
    const model = parseTranscriptFromStaticPayload("");
    // empty jsonl yields empty model (not null), but runStart is undefined
    expect(model?.runStart).toBeUndefined();
  });

  test("matches output of parseJsonl + reduceTranscript directly", () => {
    const model = parseTranscriptFromStaticPayload(MINIMAL_JSONL);
    const expected = reduceTranscript(parseJsonl(MINIMAL_JSONL));
    expect(model?.runStart?.runId).toBe(expected.runStart?.runId);
    expect(model?.runEnd?.status).toBe(expected.runEnd?.status);
    expect(model?.ordered.length).toBe(expected.ordered.length);
  });
});
