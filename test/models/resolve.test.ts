import { describe, test, expect } from "bun:test";
import { resolveProvider, parseModelFlags } from "../../src/models/resolve";

describe("resolveProvider", () => {
  test("returns anthropic for claude models", () => {
    expect(resolveProvider("claude-sonnet-4-6")).toBe("anthropic");
    expect(resolveProvider("claude-opus-4-6")).toBe("anthropic");
    expect(resolveProvider("claude-3-5-sonnet-20241022")).toBe("anthropic");
  });

  test("returns openai for gpt/o-series models", () => {
    expect(resolveProvider("gpt-4o")).toBe("openai");
    expect(resolveProvider("gpt-4o-mini")).toBe("openai");
    expect(resolveProvider("gpt-5-mini")).toBe("openai");
    expect(resolveProvider("o3")).toBe("openai");
    expect(resolveProvider("o1-preview")).toBe("openai");
  });

  test("throws for unknown model", () => {
    expect(() => resolveProvider("unknown-model")).toThrow();
  });
});

describe("parseModelFlags", () => {
  test("parses role=model pairs", () => {
    const config = parseModelFlags(["agent=gpt-4o", "fanout=claude-sonnet-4-6"]);
    expect(config.agent).toBe("gpt-4o");
    expect(config.fanout).toBe("claude-sonnet-4-6");
  });

  test("uses defaults when not specified", () => {
    const config = parseModelFlags([]);
    expect(config.agent).toBe("claude-sonnet-4-6");
  });

  test("falls back to env vars", () => {
    process.env.VET_AGENT_MODEL = "gpt-4o";
    const config = parseModelFlags([]);
    expect(config.agent).toBe("gpt-4o");
    delete process.env.VET_AGENT_MODEL;
  });
});
