import { describe, test, expect, afterEach } from "bun:test";
import { getStaticRunPayload } from "../../ui/src/components/StaticRunPage";
import type { StaticRunPayload, VetResult } from "../../ui/src/lib/api";

const FIXTURE_RESULT: VetResult = {
  schemaVersion: 5,
  runId: "card_20260101T000000Z_aaaa",
  scenario: "card",
  status: "pass",
  summary: "All good",
  reasoning: "It worked",
  observations: [],
  evidence: { screenshots: [], log: "run.jsonl" },
  duration_ms: 1,
};

afterEach(() => {
  if (typeof window !== "undefined") delete (window as any).__GAUNTLET_RUN__;
});

describe("getStaticRunPayload", () => {
  test("returns the payload when window.__GAUNTLET_RUN__ is set", () => {
    (globalThis as any).window = (globalThis as any).window ?? globalThis;
    const payload: StaticRunPayload = { result: FIXTURE_RESULT, runJsonl: "" };
    (window as any).__GAUNTLET_RUN__ = payload;
    expect(getStaticRunPayload()).toBe(payload);
  });

  test("returns null when window.__GAUNTLET_RUN__ is missing", () => {
    if (typeof window !== "undefined") delete (window as any).__GAUNTLET_RUN__;
    expect(getStaticRunPayload()).toBeNull();
  });
});
