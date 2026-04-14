import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { configEffectiveRoutes } from "../../src/api/routes/config-effective";
import { loadConfig } from "../../src/config";
import { createApp } from "../../src/api/server";

describe("GET /api/config/effective", () => {
  test("returns gauntlet + sdkEnv payload", async () => {
    const config = loadConfig({}, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const app = new Hono();
    app.route("/api/config/effective", configEffectiveRoutes(config));
    const res = await app.request("/api/config/effective");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gauntlet).toBeDefined();
    expect(body.sdkEnv).toBeDefined();
    expect(body.gauntlet.models.agent).toBe("claude-sonnet-4-6");
  });

  test("API keys reflect env at request time", async () => {
    const config = loadConfig({}, {} as NodeJS.ProcessEnv);
    const app = new Hono();
    app.route("/api/config/effective", configEffectiveRoutes(config));
    const saved = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      let body = await (await app.request("/api/config/effective")).json();
      expect(body.sdkEnv.ANTHROPIC_API_KEY).toBe("unset");

      process.env.ANTHROPIC_API_KEY = "sk-ant-xxx";
      body = await (await app.request("/api/config/effective")).json();
      expect(body.sdkEnv.ANTHROPIC_API_KEY).toBe("set");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("createApp mounts /api/config/effective alongside /api/config", async () => {
    const config = loadConfig({ dataDir: "." }, { GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);
    const app = createApp(config);

    const eff = await app.request("/api/config/effective");
    expect(eff.status).toBe(200);
    const effBody = await eff.json();
    expect(effBody.gauntlet).toBeDefined();

    const cfg = await app.request("/api/config");
    expect(cfg.status).toBe(200);
    const cfgBody = await cfg.json();
    expect(cfgBody.models).toBeDefined();
  });
});
