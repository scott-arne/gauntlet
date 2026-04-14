import { describe, test, expect } from "bun:test";
import { loadConfig, validateRunBody, mergeRunConfig } from "../src/config";

describe("loadConfig", () => {
  const emptyEnv = {} as NodeJS.ProcessEnv;

  test("all defaults when no args and empty env", () => {
    const c = loadConfig({}, emptyEnv);
    expect(c.dataDir).toBe(".");
    expect(c.port).toBe(4400);
    expect(c.defaultChrome).toEqual({ host: "127.0.0.1", port: 9222 });
    expect(c.models.agent).toBe("claude-sonnet-4-6");
    expect(c.models.fanout).toBeUndefined();
    expect(c.models.available).toEqual(["claude-sonnet-4-6"]);
    expect(c.apiKeys).toEqual({ anthropic: false, openai: false });
    expect(c.sources.dataDir).toBe("default");
  });

  test("env vars override defaults", () => {
    const c = loadConfig({}, {
      GAUNTLET_PORT: "5500",
      GAUNTLET_AGENT_MODEL: "gpt-4o",
      GAUNTLET_DATA_DIR: "/data",
      GAUNTLET_CHROME: "chrome-svc:9333",
      GAUNTLET_MODELS: "claude-sonnet-4-6,gpt-4o",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    } as NodeJS.ProcessEnv);
    expect(c.port).toBe(5500);
    expect(c.models.agent).toBe("gpt-4o");
    expect(c.dataDir).toBe("/data");
    expect(c.defaultChrome).toEqual({ host: "chrome-svc", port: 9333 });
    expect(c.models.available).toEqual(["claude-sonnet-4-6", "gpt-4o"]);
    expect(c.apiKeys.anthropic).toBe(true);
    expect(c.apiKeys.openai).toBe(false);
    expect(c.sources.port).toBe("env");
    expect(c.sources["models.agent"]).toBe("env");
  });

  test("CLI args override env vars", () => {
    const c = loadConfig(
      { port: 6600, dataDir: "/flag", chrome: "flag-host:9444", models: { agent: "claude-opus-4-6" } },
      { GAUNTLET_PORT: "5500", GAUNTLET_DATA_DIR: "/env", GAUNTLET_CHROME: "env:9333", GAUNTLET_AGENT_MODEL: "gpt-4o" } as NodeJS.ProcessEnv,
    );
    expect(c.port).toBe(6600);
    expect(c.dataDir).toBe("/flag");
    expect(c.defaultChrome).toEqual({ host: "flag-host", port: 9444 });
    expect(c.models.agent).toBe("claude-opus-4-6");
    expect(c.sources.port).toBe("flag");
    expect(c.sources.dataDir).toBe("flag");
    expect(c.sources.defaultChrome).toBe("flag");
    expect(c.sources["models.agent"]).toBe("flag");
  });

  test("invalid GAUNTLET_CHROME format throws", () => {
    expect(() => loadConfig({}, { GAUNTLET_CHROME: "no-port-here" } as NodeJS.ProcessEnv))
      .toThrow(/GAUNTLET_CHROME/);
  });

  test("invalid --chrome format throws", () => {
    expect(() => loadConfig({ chrome: "no-port-here" }, emptyEnv))
      .toThrow(/chrome/i);
  });

  test("invalid port in env throws", () => {
    expect(() => loadConfig({}, { GAUNTLET_PORT: "not-a-number" } as NodeJS.ProcessEnv))
      .toThrow(/GAUNTLET_PORT/);
  });

  test("available models falls back to [agent] when GAUNTLET_MODELS unset", () => {
    const c = loadConfig({}, { GAUNTLET_AGENT_MODEL: "gpt-4o" } as NodeJS.ProcessEnv);
    expect(c.models.available).toEqual(["gpt-4o"]);
  });

  test("apiKeys reflects both providers when both keys set", () => {
    const c = loadConfig({}, { ANTHROPIC_API_KEY: "sk-ant-xxx", OPENAI_API_KEY: "sk-xxx" } as NodeJS.ProcessEnv);
    expect(c.apiKeys).toEqual({ anthropic: true, openai: true });
  });
});

describe("validateRunBody", () => {
  test("accepts minimal body with just target", () => {
    expect(validateRunBody({ target: "http://x" })).toEqual({
      target: "http://x",
      model: undefined,
      chrome: undefined,
      adapter: undefined,
    });
  });

  test("accepts full allowed body", () => {
    const b = validateRunBody({
      target: "http://x",
      model: "gpt-4o",
      chrome: "localhost:9333",
      adapter: "web",
    });
    expect(b.target).toBe("http://x");
    expect(b.model).toBe("gpt-4o");
    expect(b.chrome).toBe("localhost:9333");
    expect(b.adapter).toBe("web");
  });

  test("rejects unknown field", () => {
    expect(() => validateRunBody({ target: "http://x", screenshotQuality: 99 }))
      .toThrow(/Unknown field.*screenshotQuality/);
  });

  test("rejects missing target", () => {
    expect(() => validateRunBody({})).toThrow(/target/);
  });

  test("rejects non-string target", () => {
    expect(() => validateRunBody({ target: 123 })).toThrow(/target/);
  });

  test("rejects non-object body", () => {
    expect(() => validateRunBody(null)).toThrow(/object/);
    expect(() => validateRunBody("string")).toThrow(/object/);
  });
});

describe("mergeRunConfig", () => {
  const app = loadConfig({}, { GAUNTLET_CHROME: "server-default:9000", GAUNTLET_AGENT_MODEL: "claude-sonnet-4-6" } as NodeJS.ProcessEnv);

  test("falls through to server defaults when body has only target", () => {
    const eff = mergeRunConfig(app, { target: "http://x" });
    expect(eff.target).toBe("http://x");
    expect(eff.model).toBe("claude-sonnet-4-6");
    expect(eff.chrome).toEqual({ host: "server-default", port: 9000 });
    expect(eff.adapter).toBe("web");
  });

  test("body chrome overrides server default", () => {
    const eff = mergeRunConfig(app, { target: "http://x", chrome: "override:9333" });
    expect(eff.chrome).toEqual({ host: "override", port: 9333 });
  });

  test("body model overrides server default", () => {
    const eff = mergeRunConfig(app, { target: "http://x", model: "gpt-4o" });
    expect(eff.model).toBe("gpt-4o");
  });

  test("invalid chrome format in body throws", () => {
    expect(() => mergeRunConfig(app, { target: "http://x", chrome: "no-port" }))
      .toThrow(/chrome/i);
  });
});
