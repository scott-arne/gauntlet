import { describe, test, expect } from "bun:test";
import { UnknownModelProviderError, parseModelFlags, resolveProvider } from "../../src/models/resolve";

describe("resolveProvider", () => {
  test("returns anthropic for claude models", () => {
    expect(resolveProvider("claude-sonnet-4-6")).toBe("anthropic");
    expect(resolveProvider("claude-opus-4-6")).toBe("anthropic");
    expect(resolveProvider("claude-3-5-sonnet-20241022")).toBe("anthropic");
  });

  test("returns anthropic for Bedrock inference-profile ids", () => {
    expect(resolveProvider("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("anthropic");
    expect(resolveProvider("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("anthropic");
    expect(resolveProvider("us.anthropic.claude-opus-4-8")).toBe("anthropic");
    expect(resolveProvider("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe("anthropic");
  });

  test("unknown-model error message lists the Bedrock inference-profile form", () => {
    try {
      resolveProvider("us.amazon.titan-text");
      throw new Error("expected resolveProvider to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownModelProviderError);
      expect((err as UnknownModelProviderError).message).toContain("anthropic.claude");
    }
  });

  test("returns openai for gpt/o-series models", () => {
    expect(resolveProvider("gpt-4o")).toBe("openai");
    expect(resolveProvider("gpt-4o-mini")).toBe("openai");
    expect(resolveProvider("gpt-5-mini")).toBe("openai");
    expect(resolveProvider("o3")).toBe("openai");
    expect(resolveProvider("o1-preview")).toBe("openai");
  });

  test("throws typed unknown-model error for unsupported prefixes", () => {
    expect(() => resolveProvider("unknown-model")).toThrow(UnknownModelProviderError);

    try {
      resolveProvider("unknown-model");
      throw new Error("expected resolveProvider to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownModelProviderError);
      expect((err as UnknownModelProviderError).code).toBe("unknown_model");
      expect((err as UnknownModelProviderError).message).toContain("claude*");
      expect((err as UnknownModelProviderError).message).toContain("gpt*");
      expect((err as UnknownModelProviderError).message).toContain("o1*");
      expect((err as UnknownModelProviderError).message).toContain("o3*");
    }
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
