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
  test("returns empty object when no flags provided", () => {
    const config = parseModelFlags([]);
    expect(config).toEqual({});
  });

  test("parses agent flag", () => {
    expect(parseModelFlags(["agent=claude-opus-4-6"])).toEqual({ agent: "claude-opus-4-6" });
  });

  test("parses fanout flag", () => {
    expect(parseModelFlags(["fanout=gpt-4o"])).toEqual({ fanout: "gpt-4o" });
  });
});
