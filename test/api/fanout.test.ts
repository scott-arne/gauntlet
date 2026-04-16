import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { fanoutRoutes } from "../../src/api/routes/fanout";
import { gauntletPath } from "../../src/paths";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Hono } from "hono";
import type { LLMClient } from "../../src/models/provider";

const STORY_MD = `---
id: story-001
title: Test story
status: draft
tags: core
---

A test story.

## Acceptance Criteria
- Something works
`;

function makeFakeClient(responseText: string): LLMClient {
  return {
    chat: async () => ({
      text: responseText,
      toolCalls: [],
      stopReason: "end_turn" as const,
      rawAssistantMessage: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    userMessage: (content: string) => ({ role: "user", content }),
    toolResultMessages: () => [],
  };
}

const GENERATED_CARD_A = `---
id: story-001-a
title: Edge case empty input
status: draft
tags: core
parent: story-001
---

Tests empty input handling.

## Acceptance Criteria
- Handles empty input gracefully
`;

const GENERATED_CARD_B = `---
id: story-001-b
title: Error path network failure
status: draft
tags: core
parent: story-001
---

Tests network failure scenario.

## Acceptance Criteria
- Shows error message on network failure
`;

describe("Fanout API", () => {
  let projectRoot: string;
  let storiesDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-fanout-api-"));
    storiesDir = gauntletPath(projectRoot, "stories");
    mkdirSync(storiesDir, { recursive: true });
    writeFileSync(join(storiesDir, "story-001-test.md"), STORY_MD);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("POST /api/fanout/:id returns 404 for unknown scenario", async () => {
    const app = new Hono();
    app.route("/api/fanout", fanoutRoutes(projectRoot, () => makeFakeClient("")));

    const res = await app.request("/api/fanout/story-999", { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not found");
  });

  test("POST /api/fanout/:id returns 400 when no model configured", async () => {
    const savedFanout = process.env.GAUNTLET_FANOUT_MODEL;
    const savedAgent = process.env.GAUNTLET_AGENT_MODEL;
    delete process.env.GAUNTLET_FANOUT_MODEL;
    delete process.env.GAUNTLET_AGENT_MODEL;

    try {
      const app = new Hono();
      app.route("/api/fanout", fanoutRoutes(projectRoot));

      const res = await app.request("/api/fanout/story-001", { method: "POST" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("no model configured");
    } finally {
      if (savedFanout !== undefined) process.env.GAUNTLET_FANOUT_MODEL = savedFanout;
      if (savedAgent !== undefined) process.env.GAUNTLET_AGENT_MODEL = savedAgent;
    }
  });

  test("POST /api/fanout/:id generates cards and writes to stories dir", async () => {
    const responseText = `${GENERATED_CARD_A}---CARD---${GENERATED_CARD_B}`;
    const client = makeFakeClient(responseText);

    const app = new Hono();
    app.route("/api/fanout", fanoutRoutes(projectRoot, () => client));

    const res = await app.request("/api/fanout/story-001", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.parent).toBe("story-001");
    expect(body.generated).toHaveLength(2);
    expect(body.generated[0].id).toBe("story-001-a");
    expect(body.generated[1].id).toBe("story-001-b");

    // Verify files were written to disk
    const files = readdirSync(storiesDir).sort();
    expect(files).toContain("story-001-a.md");
    expect(files).toContain("story-001-b.md");

    const contentA = readFileSync(join(storiesDir, "story-001-a.md"), "utf-8");
    expect(contentA).toContain("Edge case empty input");
  });
});

// --- Observation promotion tests ---

const OBS_CARD_A = `---
id: test-001-obs-1
title: Fix submit button
status: draft
tags: observation
parent: test-001
---

Submit button is unresponsive.

## Acceptance Criteria
- Button responds to clicks
`;

const OBS_CARD_B = `---
id: test-001-obs-2
title: Improve contrast
status: draft
tags: observation
parent: test-001
---

Low contrast text.

## Acceptance Criteria
- Text meets WCAG AA
`;

const FAIL_CARD_A = `---
id: test-002-fail-1
title: Investigate login crash
status: draft
tags: failure-analysis
parent: test-002
---

Login crashes on submit.

## Acceptance Criteria
- Login completes without error
`;

const FAIL_CARD_B = `---
id: test-002-fail-2
title: Verify fix under load
status: draft
tags: failure-analysis
parent: test-002
---

Re-test after fix.

## Acceptance Criteria
- Login works under concurrent load
`;

describe("Fanout observations API", () => {
  let projectRoot: string;
  let storiesDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-fanout-obs-"));
    storiesDir = gauntletPath(projectRoot, "stories");
    mkdirSync(storiesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("POST /api/fanout/:id/observations promotes observations to story cards", async () => {
    const resultsDir = gauntletPath(projectRoot, "results", "test-001");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      join(resultsDir, "result.json"),
      JSON.stringify({
        scenario: "test-001",
        status: "pass",
        summary: "Passed with observations",
        reasoning: "All good but noted issues",
        observations: [
          { kind: "bug", description: "Submit button unresponsive" },
          { kind: "a11y", description: "Low contrast text" },
        ],
        evidence: { screenshots: [], log: "run.jsonl" },
        duration_ms: 1000,
      })
    );

    const responseText = `${OBS_CARD_A}---CARD---${OBS_CARD_B}`;
    const app = new Hono();
    app.route("/api/fanout", fanoutRoutes(projectRoot, () => makeFakeClient(responseText)));

    const res = await app.request("/api/fanout/test-001/observations", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.parent).toBe("test-001");
    expect(body.generated).toHaveLength(2);
    expect(body.generated[0].id).toBe("test-001-obs-1");
    expect(body.generated[1].id).toBe("test-001-obs-2");

    const files = readdirSync(storiesDir).sort();
    expect(files).toContain("test-001-obs-a.md");
    expect(files).toContain("test-001-obs-b.md");
  });

  test("POST /api/fanout/:id/observations returns 404 when no result exists", async () => {
    const app = new Hono();
    app.route("/api/fanout", fanoutRoutes(projectRoot, () => makeFakeClient("")));

    const res = await app.request("/api/fanout/nonexistent/observations", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("Fanout failure API", () => {
  let projectRoot: string;
  let storiesDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-fanout-fail-"));
    storiesDir = gauntletPath(projectRoot, "stories");
    mkdirSync(storiesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("POST /api/fanout/:id/failure generates follow-up stories from a failed run", async () => {
    const resultsDir = gauntletPath(projectRoot, "results", "test-002");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      join(resultsDir, "result.json"),
      JSON.stringify({
        scenario: "test-002",
        status: "fail",
        summary: "Login crashed",
        reasoning: "Button handler threw exception",
        observations: [],
        evidence: { screenshots: [], log: "run.jsonl" },
        duration_ms: 2000,
      })
    );

    const responseText = `${FAIL_CARD_A}---CARD---${FAIL_CARD_B}`;
    const app = new Hono();
    app.route("/api/fanout", fanoutRoutes(projectRoot, () => makeFakeClient(responseText)));

    const res = await app.request("/api/fanout/test-002/failure", { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.parent).toBe("test-002");
    expect(body.generated).toHaveLength(2);
    expect(body.generated[0].id).toBe("test-002-fail-1");
    expect(body.generated[1].id).toBe("test-002-fail-2");

    const files = readdirSync(storiesDir).sort();
    expect(files).toContain("test-002-fail-a.md");
    expect(files).toContain("test-002-fail-b.md");
  });

  test("POST /api/fanout/:id/failure returns 400 when result is not a failure", async () => {
    const resultsDir = gauntletPath(projectRoot, "results", "test-003");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      join(resultsDir, "result.json"),
      JSON.stringify({
        scenario: "test-003",
        status: "pass",
        summary: "All good",
        reasoning: "Everything works",
        observations: [],
        evidence: { screenshots: [], log: "run.jsonl" },
        duration_ms: 500,
      })
    );

    const app = new Hono();
    app.route("/api/fanout", fanoutRoutes(projectRoot, () => makeFakeClient("")));

    const res = await app.request("/api/fanout/test-003/failure", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not a failure");
  });
});
