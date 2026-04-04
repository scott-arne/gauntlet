import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { configRoutes } from "../../src/api/routes/config";
import { Hono } from "hono";

describe("Config API", () => {
  let savedModels: string | undefined;
  let savedAgent: string | undefined;

  beforeEach(() => {
    savedModels = process.env.GAUNTLET_MODELS;
    savedAgent = process.env.GAUNTLET_AGENT_MODEL;
  });

  afterEach(() => {
    if (savedModels !== undefined) process.env.GAUNTLET_MODELS = savedModels;
    else delete process.env.GAUNTLET_MODELS;
    if (savedAgent !== undefined) process.env.GAUNTLET_AGENT_MODEL = savedAgent;
    else delete process.env.GAUNTLET_AGENT_MODEL;
  });

  test("GET /api/config returns models from GAUNTLET_MODELS", async () => {
    process.env.GAUNTLET_MODELS = "claude-sonnet-4-6,claude-opus-4-6";
    process.env.GAUNTLET_AGENT_MODEL = "claude-sonnet-4-6";

    const app = new Hono();
    app.route("/api/config", configRoutes());
    const res = await app.request("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual(["claude-sonnet-4-6", "claude-opus-4-6"]);
    expect(body.defaultModel).toBe("claude-sonnet-4-6");
  });

  test("GET /api/config falls back to GAUNTLET_AGENT_MODEL as single model", async () => {
    delete process.env.GAUNTLET_MODELS;
    process.env.GAUNTLET_AGENT_MODEL = "claude-sonnet-4-6";

    const app = new Hono();
    app.route("/api/config", configRoutes());
    const res = await app.request("/api/config");
    const body = await res.json();
    expect(body.models).toEqual(["claude-sonnet-4-6"]);
    expect(body.defaultModel).toBe("claude-sonnet-4-6");
  });

  test("GET /api/config returns empty when no model configured", async () => {
    delete process.env.GAUNTLET_MODELS;
    delete process.env.GAUNTLET_AGENT_MODEL;

    const app = new Hono();
    app.route("/api/config", configRoutes());
    const res = await app.request("/api/config");
    const body = await res.json();
    expect(body.models).toEqual([]);
    expect(body.defaultModel).toBeNull();
  });
});
