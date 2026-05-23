import { describe, test, expect, afterEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { StaticRunPage } from "../../ui/src/components/StaticRunPage";
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
  delete (window as any).__GAUNTLET_RUN__;
});

describe("StaticRunPage", () => {
  test("renders status and summary text from window payload", () => {
    (globalThis as any).window = (globalThis as any).window ?? globalThis;
    (window as any).__GAUNTLET_RUN__ = {
      result: FIXTURE_RESULT,
      runJsonl: "",
    } satisfies StaticRunPayload;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StaticRunPage />
      </MemoryRouter>
    );
    expect(html).toContain("All good");
    expect(html.toLowerCase()).toContain("pass");
  });

  test("shows a friendly message when window.__GAUNTLET_RUN__ is missing", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StaticRunPage />
      </MemoryRouter>
    );
    expect(html.toLowerCase()).toContain("no run data");
  });
});
