import { describe, test, expect } from "bun:test";
import { createAnthropicClient } from "../../src/models/anthropic";
import { createOpenAIClient } from "../../src/models/openai";

describe("API key validation", () => {
  test("Anthropic client throws clear error without API key", () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    // Clear CLAUDE_CODE_USE_BEDROCK too: when it is set in the ambient env,
    // createAnthropicClient takes the Bedrock branch and never reaches the
    // API-key check, so the test would fail spuriously. Force the direct-API
    // path regardless of ambient env.
    const origUseBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    try {
      expect(() => createAnthropicClient("claude-sonnet-4-6")).toThrow(
        /ANTHROPIC_API_KEY/
      );
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
      if (origUseBedrock) process.env.CLAUDE_CODE_USE_BEDROCK = origUseBedrock;
    }
  });

  test("OpenAI client throws clear error without API key", () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => createOpenAIClient("gpt-4o")).toThrow(
        /OPENAI_API_KEY/
      );
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
    }
  });
});
