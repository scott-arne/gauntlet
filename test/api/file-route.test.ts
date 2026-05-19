import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import { gauntletPath } from "../../src/paths";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const makeApp = (projectRoot: string, uiDir?: string) =>
  createApp(loadConfig({ projectRoot }, {} as NodeJS.ProcessEnv), uiDir);

// The file route serves a file only if the run's result.json lists it.
// This test uses a video file as the example; the same contract covers any
// file kind (screenshots, log, video, observation evidence).
describe("Manifest-gated file route", () => {
  let projectRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-file-"));
    app = makeApp(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function makeRun(scenario: string, manifest: Record<string, unknown>) {
    const runDir = gauntletPath(projectRoot, ".gauntlet", "results", scenario);
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
    const runDir = gauntletPath(projectRoot, ".gauntlet", "results", "no-manifest");
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

  test("serves a TUI capture .ansi listed in evidence.captures", async () => {
    const runDir = makeRun("with-capture", {
      schemaVersion: 2,
      scenario: "with-capture",
      status: "pass",
      evidence: { screenshots: [], log: "run.jsonl", captures: ["captures/000.ansi"] },
    });
    mkdirSync(join(runDir, "captures"), { recursive: true });
    writeFileSync(join(runDir, "captures", "000.ansi"), "raw-ansi");

    const res = await app.request("/api/results/with-capture/file/captures/000.ansi");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("raw-ansi");
  });

  test("serves the .json twin of a capture without listing it explicitly", async () => {
    // The manifest records the .ansi path; the parsed .json twin at the
    // same stem is an implicit sibling and must also be fetchable.
    const runDir = makeRun("with-capture-twin", {
      schemaVersion: 2,
      scenario: "with-capture-twin",
      status: "pass",
      evidence: { screenshots: [], log: "run.jsonl", captures: ["captures/000.ansi"] },
    });
    mkdirSync(join(runDir, "captures"), { recursive: true });
    writeFileSync(join(runDir, "captures", "000.ansi"), "raw-ansi");
    writeFileSync(join(runDir, "captures", "000.json"), '{"cols":10}');

    const res = await app.request("/api/results/with-capture-twin/file/captures/000.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  test("404s a traversal path the manifest does not list", async () => {
    makeRun("honest-manifest", {
      schemaVersion: 1,
      scenario: "honest-manifest",
      status: "pass",
      evidence: { screenshots: [], log: "run.jsonl" },
    });

    const res = await app.request("/api/results/honest-manifest/file/..%2F..%2Fresult.json");
    expect([400, 404]).toContain(res.status);
  });

  test("rejects a traversal path even when the manifest lists it (defense-in-depth)", async () => {
    // Tampered manifest: the evidence list contains a path that escapes the
    // run directory. The manifest gate would allow it (string match succeeds),
    // so only isSafePath prevents the route from serving a file outside the
    // run dir. This test verifies that second layer still catches it.
    makeRun("tampered", {
      schemaVersion: 1,
      scenario: "tampered",
      status: "pass",
      evidence: { screenshots: ["../../etc/passwd"], log: "run.jsonl" },
    });

    const res = await app.request("/api/results/tampered/file/..%2F..%2Fetc%2Fpasswd");
    expect([400, 404]).toContain(res.status);
    // Sanity: make sure the status is NOT 200 — if it were, we'd be leaking
    // files outside the scenario directory.
    expect(res.status).not.toBe(200);
  });
});
