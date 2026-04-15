import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runRoutes, executeRun } from "../../src/api/routes/run";
import { ActiveRunRegistry } from "../../src/api/active-runs";
import { RunBroadcaster } from "../../src/api/ws";
import { loadConfig } from "../../src/config";
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
  let dataDir: string;
  let storiesDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "gauntlet-run-api-"));
    storiesDir = join(dataDir, "stories");
    mkdirSync(storiesDir, { recursive: true });
    writeFileSync(join(storiesDir, "story-001-test.md"), STORY_MD);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("POST /api/run/:id returns 404 for unknown scenario", async () => {
    const config = loadConfig({ dataDir }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
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
    const config = loadConfig({ dataDir }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
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

  test("POST /api/run/:id returns 202 and registers the run", async () => {
    const config = loadConfig({ dataDir }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
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
    expect(body.id).toBe("story-001");
    // Registered synchronously before detach
    expect(registry.has("story-001")).toBe(true);

    // Give the detached task time to finish writing before afterEach rm's the dir.
    await new Promise((r) => setTimeout(r, 100));
  });

  test("executeRun unregisters before broadcasting terminal event", async () => {
    // Stub adapter that throws on start — exercises the catch + finally
    // path without needing a real LLM or Chrome.
    const stubAdapter: Adapter = {
      start: async () => { throw new Error("stub start failure"); },
      close: async () => {},
      // Unused by the error path, but required by the interface.
      type: async () => {},
      press: async () => {},
      readOutput: () => "",
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

    const registry = new ActiveRunRegistry();
    const broadcaster = new RunBroadcaster();
    registry.register({
      id: "story-001",
      title: "Test",
      target: "x",
      model: "m",
      startedAt: 1,
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
          registryHadEntryAtTerminal = registry.has("story-001");
        }
      },
    };
    broadcaster.addClient("story-001", ws as any);

    const { EvidenceLogger } = await import("../../src/evidence/logger");
    const logger = new EvidenceLogger(join(dataDir, "results", "story-001"));

    await executeRun({
      card,
      adapter: stubAdapter,
      adapterType: "cli",
      client: stubClient,
      target: "http://localhost:3000",
      outDir: join(dataDir, "results", "story-001"),
      logger,
      broadcaster,
      registry,
    });

    // After executeRun resolves, registry must be clean.
    expect(registry.has("story-001")).toBe(false);
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
      { dataDir },
      { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6", GAUNTLET_CHROME: "server:9100" } as NodeJS.ProcessEnv,
    );
    const body = validateRunBody({ target: "http://localhost:3000", chrome: "override:9333", adapter: "cli" });
    const eff = mergeRunConfig(config, body);
    expect(eff.chrome).toEqual({ host: "override", port: 9333 });

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
  });

  test("POST /api/run/:id returns 400 when model is not in allow-list", async () => {
    const config = loadConfig(
      { dataDir },
      { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6", GAUNTLET_MODELS: "claude-sonnet-4-6" } as NodeJS.ProcessEnv,
    );
    const app = new Hono();
    app.route("/api/run", runRoutes(config));

    const res = await app.request("/api/run/story-001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "http://localhost:3000", model: "gpt-4o" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("allow-list");
  });
});
