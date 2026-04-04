import { describe, test, expect } from "bun:test";
import { createAnthropicClient, anthropicToolResultMessages } from "../../src/models/anthropic";

describe("anthropicToolResultMessages", () => {
  test("creates tool_result content blocks", () => {
    const calls = [
      { id: "toolu_abc", name: "screenshot", arguments: {} },
      { id: "toolu_def", name: "click", arguments: { x: 10, y: 20 } },
    ];
    const results = [{ text: "base64data" }, { text: "clicked" }];

    const messages = anthropicToolResultMessages(calls, results);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_abc", content: "base64data" },
        { type: "tool_result", tool_use_id: "toolu_def", content: "clicked" },
      ],
    });
  });

  test("handles undefined text gracefully", () => {
    const calls = [
      { id: "toolu_abc", name: "eval", arguments: {} },
    ];
    const results = [{ text: undefined as unknown as string }];

    const messages = anthropicToolResultMessages(calls, results);

    expect(messages).toHaveLength(1);
    const content = (messages[0] as any).content;
    expect(content[0].content).toBe("");
  });

  test("handles undefined text in image result", () => {
    const calls = [
      { id: "toolu_img", name: "screenshot", arguments: {} },
    ];
    const results = [{
      text: undefined as unknown as string,
      image: { data: "aGVsbG8=", mediaType: "image/png" },
    }];

    const messages = anthropicToolResultMessages(calls, results);

    const content = (messages[0] as any).content;
    const toolResult = content[0];
    const textBlock = toolResult.content.find((b: any) => b.type === "text");
    expect(typeof textBlock.text).toBe("string");
    expect(textBlock.text).toBe("");
  });

  test("embeds image content block when image is present", () => {
    const calls = [
      { id: "toolu_img", name: "screenshot", arguments: {} },
    ];
    const results = [{
      text: "Screenshot saved to screenshots/001.png",
      image: { data: "aGVsbG8=", mediaType: "image/png" },
    }];

    const messages = anthropicToolResultMessages(calls, results);

    expect(messages).toHaveLength(1);
    const content = (messages[0] as any).content;
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_img",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "aGVsbG8=",
          },
        },
        { type: "text", text: "Screenshot saved to screenshots/001.png" },
      ],
    });
  });
});

const skip = !process.env.ANTHROPIC_API_KEY;

describe.skipIf(skip)("AnthropicClient integration", () => {
  const client = skip ? null! : createAnthropicClient("claude-sonnet-4-6");

  test("userMessage creates Anthropic user message format", () => {
    const msg = client.userMessage("hello");
    expect(msg).toEqual({ role: "user", content: "hello" });
  });
});
