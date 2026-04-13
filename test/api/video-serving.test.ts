import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../../src/api/server";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// The file route serves a file only if the run's result.json lists it.
// This test uses a video file as the example; the same contract covers any
// file kind (screenshots, log, video, observation evidence).
describe("Manifest-gated file route", () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "gauntlet-file-"));
    app = createApp(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeRun(scenario: string, manifest: Record<string, unknown>) {
    const runDir = join(dataDir, "results", scenario);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "result.json"), JSON.stringify(manifest));
    return runDir;
  }

  test("serves a file that the manifest lists", async () => {
    const runDir = makeRun("listed-video", {
      schemaVersion: 1,
      scenario: "listed-video",
      status: "pass",
      evidence: { screenshots: [], log: "run.jsonl", video: "video.webm" },
    });
    writeFileSync(join(runDir, "video.webm"), "fake-video-data");

    const res = await app.request("/api/results/listed-video/file/video.webm");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/webm");
    expect(await res.text()).toBe("fake-video-data");
  });

  test("404s when the file is on disk but not in the manifest", async () => {
    const runDir = makeRun("orphan-video", {
      schemaVersion: 1,
      scenario: "orphan-video",
      status: "pass",
      evidence: { screenshots: [], log: "run.jsonl" },
    });
    writeFileSync(join(runDir, "video.webm"), "fake-video-data");

    const res = await app.request("/api/results/orphan-video/file/video.webm");
    expect(res.status).toBe(404);
  });

  test("404s when the manifest lists the file but it is missing on disk", async () => {
    makeRun("missing-video", {
      schemaVersion: 1,
      scenario: "missing-video",
      status: "pass",
      evidence: { screenshots: [], log: "run.jsonl", video: "video.webm" },
    });
    // Note: no video.webm written

    const res = await app.request("/api/results/missing-video/file/video.webm");
    expect(res.status).toBe(404);
  });

  test("404s when the run directory has no result.json", async () => {
    const runDir = join(dataDir, "results", "no-manifest");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "video.webm"), "fake-video-data");

    const res = await app.request("/api/results/no-manifest/file/video.webm");
    expect(res.status).toBe(404);
  });

  test("serves a screenshot listed in evidence.screenshots", async () => {
    const runDir = makeRun("with-screenshot", {
      schemaVersion: 1,
      scenario: "with-screenshot",
      status: "pass",
      evidence: { screenshots: ["screenshots/001.png"], log: "run.jsonl" },
    });
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    writeFileSync(join(runDir, "screenshots", "001.png"), "fake-png-data");

    const res = await app.request("/api/results/with-screenshot/file/screenshots/001.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });
});
