import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../../src/api/server";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Results API", () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "gauntlet-results-api-"));
    // Create stories dir (needed by scenarioRoutes)
    mkdirSync(join(dataDir, "stories"), { recursive: true });
    // Create results
    const resultsDir = join(dataDir, "results");
    mkdirSync(join(resultsDir, "test-001"), { recursive: true });
    writeFileSync(
      join(resultsDir, "test-001", "result.json"),
      JSON.stringify({
        scenario: "test-001",
        status: "pass",
        summary: "All good",
        reasoning: "Everything works",
        observations: [],
        evidence: { screenshots: [], log: "run.jsonl" },
        duration_ms: 1234,
      })
    );
    mkdirSync(join(resultsDir, "test-002"), { recursive: true });
    writeFileSync(
      join(resultsDir, "test-002", "result.json"),
      JSON.stringify({
        scenario: "test-002",
        status: "fail",
        summary: "Button broken",
        reasoning: "Click didn't work",
        observations: [
          { kind: "bug", description: "Submit button unresponsive" },
        ],
        evidence: { screenshots: ["001.png"], log: "run.jsonl" },
        duration_ms: 5678,
      })
    );

    app = createApp(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("GET /api/results lists all results", async () => {
    const res = await app.request("/api/results");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(
      body
        .map((r: any) => r.scenario)
        .sort()
    ).toEqual(["test-001", "test-002"]);
  });

  test("GET /api/results/:scenario returns a specific result", async () => {
    const res = await app.request("/api/results/test-002");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenario).toBe("test-002");
    expect(body.status).toBe("fail");
    expect(body.observations).toHaveLength(1);
  });

  test("GET /api/results/:scenario returns 404 for missing", async () => {
    const res = await app.request("/api/results/nonexistent");
    expect(res.status).toBe(404);
  });

  test("GET /api/results handles malformed result.json gracefully", async () => {
    const badDir = mkdtempSync(join(tmpdir(), "gauntlet-bad-json-"));
    mkdirSync(join(badDir, "stories"), { recursive: true });
    const resultsDir = join(badDir, "results");
    mkdirSync(join(resultsDir, "bad-001"), { recursive: true });
    writeFileSync(join(resultsDir, "bad-001", "result.json"), "not valid json{{{");

    const badApp = createApp(badDir);
    const res = await badApp.request("/api/results");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Malformed entries should be skipped, not crash the server
    expect(body).toEqual([]);
    rmSync(badDir, { recursive: true, force: true });
  });

  test("GET /api/results/:scenario returns 500 for malformed result.json", async () => {
    const badDir = mkdtempSync(join(tmpdir(), "gauntlet-bad-json2-"));
    mkdirSync(join(badDir, "stories"), { recursive: true });
    const resultsDir = join(badDir, "results");
    mkdirSync(join(resultsDir, "bad-002"), { recursive: true });
    writeFileSync(join(resultsDir, "bad-002", "result.json"), "not json");

    const badApp = createApp(badDir);
    const res = await badApp.request("/api/results/bad-002");
    expect(res.status).toBe(500);
    rmSync(badDir, { recursive: true, force: true });
  });

  test("GET /api/results/:scenario rejects path traversal in scenario", async () => {
    // Hono normalizes URLs, so we test via the route handler's path check
    // by using URL-encoded traversal that survives normalization
    const res = await app.request("/api/results/..%2F..%2Fetc");
    // Should either 400 (path rejected) or 404 (not found), never serve outside resultsDir
    expect([400, 404]).toContain(res.status);
  });

  test("GET /api/results returns empty array when no results dir", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "gauntlet-empty-"));
    mkdirSync(join(emptyDir, "stories"), { recursive: true });
    const emptyApp = createApp(emptyDir);
    const res = await emptyApp.request("/api/results");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
