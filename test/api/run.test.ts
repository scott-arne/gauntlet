import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runRoutes, executeHttpRun } from "../../src/api/routes/run";
import { ActiveRunRegistry } from "../../src/api/active-runs";
import { RunBroadcaster } from "../../src/api/ws";
import { loadConfig, mergeRunConfig, validateRunBody } from "../../src/config";
import { gauntletPath } from "../../src/paths";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Hono } from "hono";
import type { Adapter } from "../../src/adapters/adapter";
import type { LLMClient } from "../../src/models/provider";
import type { StoryCard } from "../../src/format/story-card";

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

describe("Run API", () => {
  let projectRoot: string;
  let storiesDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-run-api-"));
    storiesDir = gauntletPath(projectRoot, ".gauntlet", "stories");
    mkdirSync(storiesDir, { recursive: true });
    writeFileSync(join(storiesDir, "story-001-test.md"), STORY_MD);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  test("POST /api/run/:id returns 404 for unknown scenario", async () => {
    const config = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const app = new Hono();
    app.route("/api/run", runRoutes(config));

    const res = await app.request("/api/run/story-999", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "http://localhost:3000" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not found");
  });

  test("POST /api/run/:id returns 400 when target is missing", async () => {
    const config = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const app = new Hono();
    app.route("/api/run", runRoutes(config));

    const res = await app.request("/api/run/story-001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("target");
  });

  test("POST /api/run/:id returns 400 when body includes turns field", async () => {
    const config = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const app = new Hono();
    app.route("/api/run", runRoutes(config));

    const res = await app.request("/api/run/story-001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "http://localhost:3000", turns: 10 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/`turns` is no longer accepted/);
  });

  test("POST /api/run/:id returns JSON 400 for unknown model prefix before registering a run", async () => {
    const config = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const registry = new ActiveRunRegistry();
    const app = new Hono();
    app.route("/api/run", runRoutes(config, undefined, undefined, registry));

    const res = await app.request("/api/run/story-001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "http://localhost:3000", model: "unknown-model" }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("unknown_model");
    expect(body.message).toContain("claude*");
    expect(body.message).toContain("gpt*");
    expect(body.message).toContain("o1*");
    expect(body.message).toContain("o3*");
    expect(registry.list()).toEqual([]);
  });

  test("POST /api/run/:id returns 202 with uniform shape and registers by runId", async () => {
    // createClient reads ANTHROPIC_API_KEY from process.env directly.
    // Stub it just for this test so the createClient call doesn't throw
    // before we reach the registry assertion.
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
    const config = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const registry = new ActiveRunRegistry();
    const broadcaster = new RunBroadcaster();
    const app = new Hono();
    app.route("/api/run", runRoutes(config, broadcaster, undefined, registry));

    // This will fail downstream (no real Chrome) but should still return 202
    // because start is detached. We only assert the acknowledgement + registration.
    const res = await app.request("/api/run/story-001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "http://localhost:3000", adapter: "cli" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    // New uniform response shape: runSetId is null for solo runs.
    expect(body.runSetId).toBeNull();
    expect(body.passes).toBe(1);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].runId).toMatch(/^story-001_\d{8}T\d{6}Z_[a-z0-9]{4}$/);
    // Registered synchronously before detach, keyed by runId (not cardId).
    expect(registry.has(body.runs[0].runId)).toBe(true);
    expect(registry.has("story-001")).toBe(false);

    // PRI-1507: solo path attaches an AbortController on register so
    // shutdown drain can fire it on grace-window expiry.
    expect(registry.getAbortController(body.runs[0].runId)).toBeDefined();

    // Give the detached task time to finish writing before afterEach rm's the dir.
    await new Promise((r) => setTimeout(r, 100));
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("executeRun unregisters before broadcasting terminal event (keyed by runId)", async () => {
    // Stub adapter that throws on start — exercises the catch + finally
    // path without needing a real LLM or Chrome.
    const stubAdapter: Adapter = {
      name: "cli",
      start: async () => { throw new Error("stub start failure"); },
      close: async () => {},
      // Unused by the error path, but required by the interface.
      type: async () => {},
      press: async () => {},
      readOutput: () => "",
      describeTarget: (t: string) => `running: ${t}`,
      defaultViewport: () => null,
      isMutatingTool: () => false,
    } as unknown as Adapter;

    const stubClient: LLMClient = {} as unknown as LLMClient;

    const card: StoryCard = {
      id: "story-001",
      title: "Test",
      status: "draft",
      tags: ["core"],
      body: "",
      acceptance: ["Something works"],
    } as unknown as StoryCard;

    const runId = "story-001_20260416T142301Z_test";
    const registry = new ActiveRunRegistry();
    const broadcaster = new RunBroadcaster();
    registry.register({
      id: runId,
      cardId: "story-001",
      title: "Test",
      target: "x",
      model: "m",
      startedAt: 1,
      status: "running",
    });

    // Track the order of unregister vs. the terminal broadcast. A fake WS
    // client captures whether the registry still held this run at the
    // moment the terminal event arrived. It must already be empty.
    let registryHadEntryAtTerminal: boolean | null = null;
    const ws = {
      readyState: 1,
      send(data: string) {
        const msg = JSON.parse(data);
        if (msg.type === "complete" || msg.type === "error") {
          registryHadEntryAtTerminal = registry.has(runId);
        }
      },
    };
    broadcaster.addClient(runId, ws as any);

    // Write a minimal story file so snapshotRunInputs has something to copy.
    const storyDir = gauntletPath(projectRoot, ".gauntlet", "stories");
    mkdirSync(storyDir, { recursive: true });
    const storyPath = join(storyDir, "story-001.md");
    writeFileSync(storyPath, `---\nid: story-001\ntitle: Test\nstatus: draft\ntags: core\n---\n\nbody\n\n## Acceptance Criteria\n- works\n`);

    const cfg = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const effective = mergeRunConfig(cfg, validateRunBody({
      target: "http://localhost:3000",
      adapter: "cli",
    }));

    // executeHttpRun rethrows after running all cleanup hooks (onError →
    // beforeClose → adapter.close → detachLogger → afterClose). Swallow
    // the rethrow; the assertions below verify the hook ordering.
    await executeHttpRun({
      runId,
      card,
      storyPath,
      client: stubClient,
      effective,
      projectRoot,
      stateDirName: ".gauntlet",
      broadcaster,
      registry,
      adapterFactory: () => stubAdapter,
    }).catch(() => { /* expected: stub throws on start */ });

    // After executeHttpRun resolves, registry must be clean.
    expect(registry.has(runId)).toBe(false);
    // And when the terminal event fired, the entry was already gone.
    expect(registryHadEntryAtTerminal).toBe(false);
  });

  test("POST /api/run/:id body chrome override wins over server default", async () => {
    // Server default points at one host, body overrides with another.
    // We use adapter: cli to avoid touching real Chrome — the assertion is
    // that mergeRunConfig (called inside the route) honors the body override.
    // We import mergeRunConfig directly to validate the threading.
    const { mergeRunConfig, validateRunBody } = await import("../../src/config");
    const config = loadConfig(
      { projectRoot },
      { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6", GAUNTLET_CHROME: "server:9100" } as NodeJS.ProcessEnv,
    );
    const body = validateRunBody({ target: "http://localhost:3000", chrome: "override:9333", adapter: "cli" });
    const eff = mergeRunConfig(config, body);
    expect(eff.chrome).toEqual({ host: "override", port: 9333 });

    // The route's createClient call reads ANTHROPIC_API_KEY from
    // process.env directly — stub it for the duration of this assertion
    // so the 202 path is exercised without a real key.
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
    // And confirm the route accepts the request (returns 202).
    const app = new Hono();
    app.route("/api/run", runRoutes(config));
    const res = await app.request("/api/run/story-001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "http://localhost:3000", chrome: "override:9333", adapter: "cli" }),
    });
    expect(res.status).toBe(202);

    await new Promise((r) => setTimeout(r, 100));
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("POST /api/run/:id returns 400 when model is not in allow-list", async () => {
    // GAUNTLET_MODELS, when set, is enforced at the route layer.
    const config = loadConfig(
      { projectRoot },
      { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6", GAUNTLET_MODELS: "claude-sonnet-4-6" } as NodeJS.ProcessEnv,
    );
    const app = new Hono();
    app.route("/api/run", runRoutes(config));

    const res = await app.request("/api/run/story-001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "http://localhost:3000", model: "claude-opus-4-6" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("allow-list");
  });

  test("rejects unknown adapter value with 400", async () => {
    const config = loadConfig(
      { projectRoot },
      { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv,
    );
    const app = new Hono();
    app.route("/api/run", runRoutes(config));

    const res = await app.request("/api/run/story-001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "http://localhost:3000", adapter: "wat" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("adapter");
    expect(body.error).toContain("web");
  });

  // Screencast save-opt-in gate.
  //
  // These drive executeRun directly with a stub "web" adapter so we can
  // pin the disk behavior without spinning up Chrome. The streamer's
  // constructor calls mkdirSync(framesDir, {recursive: true}) BEFORE
  // start() is awaited — so even though streamer.start() will fail when
  // chrome.getTabs() has no real browser to talk to, the dir-creation
  // side-effect has already happened (or not) by that point.
  //
  // We assert both directions: saveScreencast=false => no frames dir,
  // saveScreencast=true => frames dir exists.
  async function runExecuteWithStubbedWebAdapter(saveScreencast: boolean) {
    const { ActiveRunRegistry } = await import("../../src/api/active-runs");
    const registry = new ActiveRunRegistry();

    const stubAdapter: Adapter = {
      name: "web",
      start: async () => {},
      close: async () => {},
      type: async () => {},
      press: async () => {},
      readOutput: () => "",
      describeTarget: (t: string) => `running: ${t}`,
      defaultViewport: () => null,
      isMutatingTool: () => false,
      // PRI-1436: executeRun reads getChromeSession() to thread the
      // session into the streamer. Stub returns an empty session — the
      // streamer's constructor mkdirs synchronously before the session
      // is ever exercised.
      getChromeSession: () => ({}),
    } as unknown as Adapter;
    const stubClient: LLMClient = {} as unknown as LLMClient;
    const card: StoryCard = {
      id: "story-001",
      title: "Test",
      status: "draft",
      tags: ["core"],
      body: "",
      acceptance: ["Something works"],
    } as unknown as StoryCard;

    const runId = `story-001_20260422T120000Z_${saveScreencast ? "save" : "drop"}`;

    // Write a minimal story file so snapshotRunInputs has something to copy.
    const storyDir = gauntletPath(projectRoot, ".gauntlet", "stories");
    mkdirSync(storyDir, { recursive: true });
    const storyPath = join(storyDir, "story-001.md");
    writeFileSync(storyPath, `---\nid: story-001\ntitle: Test\nstatus: draft\ntags: core\n---\n\nbody\n\n## Acceptance Criteria\n- works\n`);

    const cfg = loadConfig({ projectRoot }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const effective = mergeRunConfig(cfg, validateRunBody({
      target: "http://localhost:3000",
      adapter: "web",
      saveScreencast,
    }));

    // executeHttpRun catches the streamer.start() failure (chrome not
    // running) and falls through to cleanup — fine for our purposes,
    // the constructor's mkdir side-effect already happened synchronously.
    await executeHttpRun({
      runId,
      card,
      storyPath,
      client: stubClient,
      effective,
      projectRoot,
      stateDirName: ".gauntlet",
      registry,
      adapterFactory: () => stubAdapter,
    }).catch(() => { /* swallow expected streamer failure */ });

    return { framesDir: join(gauntletPath(projectRoot, ".gauntlet", "results", runId), "frames") };
  }

  test("screencast gate: saveScreencast=false does NOT create frames/ on disk", async () => {
    const { existsSync } = await import("fs");
    const { framesDir } = await runExecuteWithStubbedWebAdapter(false);
    expect(existsSync(framesDir)).toBe(false);
  });

  test("screencast gate: saveScreencast=true creates frames/ on disk", async () => {
    const { existsSync } = await import("fs");
    const { framesDir } = await runExecuteWithStubbedWebAdapter(true);
    expect(existsSync(framesDir)).toBe(true);
  });
});
