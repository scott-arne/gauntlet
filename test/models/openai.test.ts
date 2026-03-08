import { describe, test, expect } from "bun:test";
import { createOpenAIClient } from "../../src/models/openai";

const skip = !process.env.OPENAI_API_KEY;

describe.skipIf(skip)("OpenAIClient", () => {
  const client = skip ? null! : createOpenAIClient("gpt-5-mini");

  test("userMessage creates OpenAI user message format", () => {
    const msg = client.userMessage("hello");
    expect(msg).toEqual({ role: "user", content: "hello" });
  });

  test("toolResultMessages creates one tool message per call", () => {
    const calls = [
      { id: "call_abc", name: "screenshot", arguments: {} },
      { id: "call_def", name: "click", arguments: { x: 10, y: 20 } },
    ];
    const results = ["base64data", "clicked"];

    const messages = client.toolResultMessages(calls, results);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_abc",
      content: "base64data",
    });
    expect(messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_def",
      content: "clicked",
    });
  });
});
