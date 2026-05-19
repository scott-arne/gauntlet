import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import { gauntletPath } from "../../src/paths";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const makeApp = (projectRoot: string, uiDir?: string) =>
  createApp(loadConfig({ projectRoot }, {} as NodeJS.ProcessEnv), uiDir);

describe("Static UI serving", () => {
  let projectRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-static-"));
    mkdirSync(gauntletPath(projectRoot, ".gauntlet", "stories"), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("serves index.html for unknown routes when UI is built", async () => {
    const uiDir = join(projectRoot, "ui-dist");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(join(uiDir, "index.html"), "<html><body>gauntlet ui</body></html>");

    app = makeApp(projectRoot, uiDir);
    const res = await app.request("/cards");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    const text = await res.text();
    expect(text).toContain("gauntlet ui");
  });

  test("serves static assets from UI dist", async () => {
    const uiDir = join(projectRoot, "ui-dist");
    const assetsDir = join(uiDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "main.js"), "console.log('hello')");

    app = makeApp(projectRoot, uiDir);
    const res = await app.request("/assets/main.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/javascript");
    const text = await res.text();
    expect(text).toBe("console.log('hello')");
  });

  test("API routes still work with UI serving enabled", async () => {
    const uiDir = join(projectRoot, "ui-dist");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(join(uiDir, "index.html"), "<html></html>");

    app = makeApp(projectRoot, uiDir);
    const res = await app.request("/api/scenarios");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("works without UI dist directory", async () => {
    app = makeApp(projectRoot);
    const res = await app.request("/cards");
    expect(res.status).toBe(404);
  });
});
