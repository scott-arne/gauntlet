import { describe, test, expect } from "bun:test";
import { createAnthropicClient } from "../../src/models/anthropic";
import { createOpenAIClient } from "../../src/models/openai";

describe("API key validation", () => {
  test("Anthropic client throws clear error without API key", () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => createAnthropicClient("claude-sonnet-4-6")).toThrow(
        /ANTHROPIC_API_KEY/
      );
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
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
