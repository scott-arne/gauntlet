import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import { gauntletPath } from "../../src/paths";
import { ActiveRunRegistry } from "../../src/api/active-runs";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const makeApp = (projectRoot: string, uiDir?: string) =>
  createApp(loadConfig({ projectRoot }, {} as NodeJS.ProcessEnv), uiDir);

const makeAppWithRegistry = (projectRoot: string, registry: ActiveRunRegistry) =>
  createApp(loadConfig({ projectRoot }, {} as NodeJS.ProcessEnv), undefined, undefined, registry);

describe("Results API", () => {
  let projectRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-results-api-"));
    // Create stories dir (needed by scenarioRoutes)
    mkdirSync(gauntletPath(projectRoot, ".gauntlet", "stories"), { recursive: true });
    // Create results. Directory names are runIds (`cardId_ts_nonce`); the
    // older tests used cardIds directly because runId wasn't yet primary,
    // but the route itself treats the directory name opaquely as the runId.
    const resultsDir = gauntletPath(projectRoot, ".gauntlet", "results");
    mkdirSync(join(resultsDir, "test-001_20260401T100000Z_aaaa"), { recursive: true });
    writeFileSync(
      join(resultsDir, "test-001_20260401T100000Z_aaaa", "result.json"),
      JSON.stringify({
        runId: "test-001_20260401T100000Z_aaaa",
        scenario: "test-001",
        status: "pass",
        summary: "All good",
        reasoning: "Everything works",
        observations: [],
        evidence: { screenshots: [], log: "run.jsonl" },
        duration_ms: 1234,
      })
    );
    mkdirSync(join(resultsDir, "test-002_20260401T110000Z_bbbb"), { recursive: true });
    writeFileSync(
      join(resultsDir, "test-002_20260401T110000Z_bbbb", "result.json"),
      JSON.stringify({
        runId: "test-002_20260401T110000Z_bbbb",
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

    app = makeApp(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("GET /api/results returns first page and total", async () => {
    const res = await app.request("/api/results");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.results).toHaveLength(2);
    // Sort is runId-desc: test-002_20260401T110000Z... > test-001_20260401T100000Z...
    expect(body.results[0].runId).toBe("test-002_20260401T110000Z_bbbb");
    expect(body.results[1].runId).toBe("test-001_20260401T100000Z_aaaa");
  });

  test("GET /api/results?cardId=<id> filters to that card's runs only", async () => {
    // Add a second run for test-001 to prove the filter does more than pass
    // through a single row.
    const resultsDir = gauntletPath(projectRoot, ".gauntlet", "results");
    mkdirSync(join(resultsDir, "test-001_20260401T120000Z_cccc"), { recursive: true });
    writeFileSync(
      join(resultsDir, "test-001_20260401T120000Z_cccc", "result.json"),
      JSON.stringify({
        runId: "test-001_20260401T120000Z_cccc",
        scenario: "test-001",
        status: "fail",
        summary: "Regressed",
        reasoning: "",
        observations: [],
        evidence: { screenshots: [], log: "run.jsonl" },
        duration_ms: 2000,
      })
    );

    const res = await app.request("/api/results?cardId=test-001");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.results).toHaveLength(2);
    for (const r of body.results) {
      expect(r.scenario).toBe("test-001");
    }
  });

  test("GET /api/results honors limit and offset", async () => {
    // Add enough rows to exercise pagination.
    const resultsDir = gauntletPath(projectRoot, ".gauntlet", "results");
    for (let i = 0; i < 5; i++) {
      const ts = `20260402T10000${i}Z`;
      const dir = `pad-${i}_${ts}_aaaa`;
      mkdirSync(join(resultsDir, dir), { recursive: true });
      writeFileSync(
        join(resultsDir, dir, "result.json"),
        JSON.stringify({
          runId: dir,
          scenario: `pad-${i}`,
          status: "pass",
          summary: "",
          reasoning: "",
          observations: [],
          evidence: { screenshots: [], log: "run.jsonl" },
          duration_ms: 0,
        })
      );
    }

    const res1 = await app.request("/api/results?limit=3&offset=0");
    const body1 = await res1.json();
    expect(body1.total).toBe(7);
    expect(body1.limit).toBe(3);
    expect(body1.offset).toBe(0);
    expect(body1.results).toHaveLength(3);

    const res2 = await app.request("/api/results?limit=3&offset=3");
    const body2 = await res2.json();
    expect(body2.total).toBe(7);
    expect(body2.offset).toBe(3);
    expect(body2.results).toHaveLength(3);

    // Pages don't overlap.
    const ids1 = new Set(body1.results.map((r: any) => r.runId));
    const ids2 = new Set(body2.results.map((r: any) => r.runId));
    for (const id of ids2) expect(ids1.has(id)).toBe(false);

    // offset beyond total yields empty page but preserves total.
    const res3 = await app.request("/api/results?limit=3&offset=99");
    const body3 = await res3.json();
    expect(body3.total).toBe(7);
    expect(body3.results).toHaveLength(0);
  });

  test("GET /api/results clamps absurd limit to MAX_LIMIT", async () => {
    const res = await app.request("/api/results?limit=9999");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(200);
  });

  test("GET /api/results/:runId returns a specific result", async () => {
    const res = await app.request("/api/results/test-002_20260401T110000Z_bbbb");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenario).toBe("test-002");
    expect(body.status).toBe("fail");
    expect(body.observations).toHaveLength(1);
  });

  test("GET /api/results/:runId returns 404 for missing", async () => {
    const res = await app.request("/api/results/nonexistent");
    expect(res.status).toBe(404);
  });

  test("GET /api/results handles malformed result.json gracefully", async () => {
    const badDir = mkdtempSync(join(tmpdir(), "gauntlet-bad-json-"));
    mkdirSync(gauntletPath(badDir, ".gauntlet", "stories"), { recursive: true });
    const resultsDir = gauntletPath(badDir, ".gauntlet", "results");
    mkdirSync(join(resultsDir, "bad-001_20260401T000000Z_aaaa"), { recursive: true });
    writeFileSync(join(resultsDir, "bad-001_20260401T000000Z_aaaa", "result.json"), "not valid json{{{");

    const badApp = makeApp(badDir);
    const res = await badApp.request("/api/results");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Malformed entries should be skipped from the returned page, not crash
    // the server. Total still reflects the on-disk count: the paginator
    // counts directories, not parsed rows.
    expect(body.results).toEqual([]);
    expect(body.total).toBe(1);
    rmSync(badDir, { recursive: true, force: true });
  });

  test("GET /api/results/:runId returns 500 for malformed result.json", async () => {
    const badDir = mkdtempSync(join(tmpdir(), "gauntlet-bad-json2-"));
    mkdirSync(gauntletPath(badDir, ".gauntlet", "stories"), { recursive: true });
    const resultsDir = gauntletPath(badDir, ".gauntlet", "results");
    mkdirSync(join(resultsDir, "bad-002"), { recursive: true });
    writeFileSync(join(resultsDir, "bad-002", "result.json"), "not json");

    const badApp = makeApp(badDir);
    const res = await badApp.request("/api/results/bad-002");
    expect(res.status).toBe(500);
    rmSync(badDir, { recursive: true, force: true });
  });

  test("GET /api/results/:runId rejects path traversal", async () => {
    // Hono normalizes URLs, so we test via the route handler's path check
    // by using URL-encoded traversal that survives normalization
    const res = await app.request("/api/results/..%2F..%2Fetc");
    // Should either 400 (path rejected) or 404 (not found), never serve outside resultsDir
    expect([400, 404]).toContain(res.status);
  });

  test("GET /api/results/:runId/file/:path serves files from a live run without a manifest", async () => {
    // A run that's in flight: no result.json yet, but screenshots and
    // run.jsonl are being written. The file route should skip the
    // manifest check when the run is in the active registry.
    const liveDir = mkdtempSync(join(tmpdir(), "gauntlet-live-"));
    mkdirSync(gauntletPath(liveDir, ".gauntlet", "stories"), { recursive: true });
    const resultsDir = gauntletPath(liveDir, ".gauntlet", "results");
    const runId = "live-001_20260422T000000Z_aaaa";
    const runDir = join(resultsDir, runId);
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    writeFileSync(join(runDir, "screenshots", "001.png"), Buffer.from("fake-png"));
    writeFileSync(join(runDir, "run.jsonl"), '{"type":"run_start"}\n');
    // No result.json yet — run is still going.

    const registry = new ActiveRunRegistry();
    registry.register({
      id: runId,
      cardId: "live-001",
      title: "live",
      target: "http://localhost:3000",
      model: "claude-sonnet-4-6",
      startedAt: Date.now(),
      status: "running",
    });

    const liveApp = makeAppWithRegistry(liveDir, registry);

    const shot = await liveApp.request(`/api/results/${runId}/file/screenshots/001.png`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toContain("image/png");

    const log = await liveApp.request(`/api/results/${runId}/file/run.jsonl`);
    expect(log.status).toBe(200);

    // Path traversal is still blocked even during a live run.
    const traversal = await liveApp.request(`/api/results/${runId}/file/..%2F..%2Fetc`);
    expect([400, 404]).toContain(traversal.status);

    rmSync(liveDir, { recursive: true, force: true });
  });

  test("GET /api/results/:runId/file/:path still enforces manifest on completed runs", async () => {
    // Existing test-001 has result.json with evidence.screenshots=[] — no
    // screenshot files are listed. A request for a screenshot file should
    // 404 even if it exists on disk (manifest is authoritative post-run).
    const resultsDir = gauntletPath(projectRoot, ".gauntlet", "results");
    mkdirSync(join(resultsDir, "test-001_20260401T100000Z_aaaa", "screenshots"), { recursive: true });
    writeFileSync(
      join(resultsDir, "test-001_20260401T100000Z_aaaa", "screenshots", "stray.png"),
      Buffer.from("stray"),
    );

    const res = await app.request(
      "/api/results/test-001_20260401T100000Z_aaaa/file/screenshots/stray.png",
    );
    expect(res.status).toBe(404);
  });

  test("GET /api/results returns empty page when no results dir", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "gauntlet-empty-"));
    mkdirSync(gauntletPath(emptyDir, ".gauntlet", "stories"), { recursive: true });
    const emptyApp = makeApp(emptyDir);
    const res = await emptyApp.request("/api/results");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
