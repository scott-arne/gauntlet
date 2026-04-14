import { describe, test, expect } from "bun:test";
import { configRoutes } from "../../src/api/routes/config";
import { loadConfig } from "../../src/config";
import { Hono } from "hono";

describe("Config API", () => {
  test("GET /api/config returns models from GAUNTLET_MODELS", async () => {
    const config = loadConfig({}, {
      GAUNTLET_MODELS: "claude-sonnet-4-6,claude-opus-4-6",
      GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6",
    } as NodeJS.ProcessEnv);

    const app = new Hono();
    app.route("/api/config", configRoutes(config));
    const res = await app.request("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual(["claude-sonnet-4-6", "claude-opus-4-6"]);
    expect(body.defaultModel).toBe("claude-sonnet-4-6");
  });

  test("GET /api/config falls back to GAUNTLET_AGENT_MODEL as single model", async () => {
    const config = loadConfig({}, {
      GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6",
    } as NodeJS.ProcessEnv);

    const app = new Hono();
    app.route("/api/config", configRoutes(config));
    const res = await app.request("/api/config");
    const body = await res.json();
    expect(body.models).toEqual(["claude-sonnet-4-6"]);
    expect(body.defaultModel).toBe("claude-sonnet-4-6");
  });

  test("GET /api/config returns defaults when no env configured", async () => {
    const config = loadConfig({}, {} as NodeJS.ProcessEnv);
    const app = new Hono();
    app.route("/api/config", configRoutes(config));
    const res = await app.request("/api/config");
    const body = await res.json();
    // loadConfig defaults agent to claude-sonnet-4-6 and seeds available
    // from that, so the API never returns a truly empty list.
    expect(body.models).toEqual(["claude-sonnet-4-6"]);
    expect(body.defaultModel).toBe("claude-sonnet-4-6");
  });

  test("GET /api/config reflects flag-sourced model (flag beats env)", async () => {
    const config = loadConfig(
      { models: { agent: "claude-opus-4-6" } },
      { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv,
    );
    const app = new Hono();
    app.route("/api/config", configRoutes(config));
    const res = await app.request("/api/config");
    const body = await res.json();
    expect(body.defaultModel).toBe("claude-opus-4-6");
  });
});
