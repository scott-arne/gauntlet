import { describe, test, expect } from "bun:test";
import {
  createAnthropicClient,
  anthropicToolResultMessages,
  convertResponse,
  useBedrock,
  createBedrockMessagesClient,
} from "../../src/models/anthropic";
import type Anthropic from "@anthropic-ai/sdk";

import { maxOutputTokensForModel } from "../../src/models/anthropic";

// Set the given env vars (undefined deletes), run body, then restore. Mirrors
// the direct-process.env style the rest of this suite uses.
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const keys = Object.keys(vars);
  const prev: Record<string, string | undefined> = {};
  for (const key of keys) {
    prev[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    body();
  } finally {
    for (const key of keys) {
      const original = prev[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

describe("maxOutputTokensForModel", () => {
  test("legacy Claude 3.0 family is capped at 4096", () => {
    expect(maxOutputTokensForModel("claude-3-opus-20240229")).toBe(4096);
    expect(maxOutputTokensForModel("claude-3-haiku-20240307")).toBe(4096);
    expect(maxOutputTokensForModel("claude-3-sonnet-20240229")).toBe(4096);
  });

  test("Claude 3.5/3.7 family is capped at 8192", () => {
    expect(maxOutputTokensForModel("claude-3-5-sonnet-20241022")).toBe(8192);
    expect(maxOutputTokensForModel("claude-3-5-haiku-20241022")).toBe(8192);
    expect(maxOutputTokensForModel("claude-3-7-sonnet-20250219")).toBe(8192);
  });

  test("known current model families get the full 16384 budget", () => {
    expect(maxOutputTokensForModel("claude-sonnet-4-6")).toBe(16384);
    expect(maxOutputTokensForModel("claude-opus-4-7")).toBe(16384);
    expect(maxOutputTokensForModel("claude-opus-4-20250514")).toBe(16384);
    expect(maxOutputTokensForModel("claude-haiku-4-5-20251001")).toBe(16384);
    expect(maxOutputTokensForModel("claude-fable-5")).toBe(16384);
    expect(maxOutputTokensForModel("claude-mythos-5")).toBe(16384);
  });

  test("unrecognized or ancient model ids fall back to the conservative 4096", () => {
    expect(maxOutputTokensForModel("claude-2.1")).toBe(4096);
    expect(maxOutputTokensForModel("claude-instant-1.2")).toBe(4096);
    expect(maxOutputTokensForModel("claude-experimental-thing")).toBe(4096);
  });

  test("Bedrock inference-profile ids resolve to the same cap as their bare family", () => {
    // Regional prefix + anthropic. vendor segment must be stripped before the
    // family match, or a Bedrock id would silently fall back to 4096.
    expect(maxOutputTokensForModel("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(16384);
    expect(maxOutputTokensForModel("us.anthropic.claude-opus-4-8")).toBe(16384);
    expect(maxOutputTokensForModel("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(16384);
    expect(maxOutputTokensForModel("apac.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(16384);
    expect(maxOutputTokensForModel("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(8192);
  });
});

describe("useBedrock", () => {
  test("true for 1/true/yes (case-insensitive), false otherwise", () => {
    for (const v of ["1", "true", "TRUE", "Yes", " yes "]) {
      withEnv({ CLAUDE_CODE_USE_BEDROCK: v }, () => {
        expect(useBedrock()).toBe(true);
      });
    }
    for (const v of ["0", "false", "no", ""]) {
      withEnv({ CLAUDE_CODE_USE_BEDROCK: v }, () => {
        expect(useBedrock()).toBe(false);
      });
    }
    withEnv({ CLAUDE_CODE_USE_BEDROCK: undefined }, () => {
      expect(useBedrock()).toBe(false);
    });
  });
});

describe("createBedrockMessagesClient (InvokeModel adapter)", () => {
  function fakeAwsResponse(message: Record<string, unknown>) {
    return { body: new TextEncoder().encode(JSON.stringify(message)) };
  }

  test("maps model→modelId, injects anthropic_version, JSON-encodes the body, and preserves params", async () => {
    let capturedInput: any = null;
    const fakeSend = async (command: any) => {
      capturedInput = command.input;
      return fakeAwsResponse({
        id: "msg_x",
        type: "message",
        role: "assistant",
        model: "us.anthropic.claude-opus-4-8",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    };

    const client = createBedrockMessagesClient("us.anthropic.claude-opus-4-8", {
      region: "us-east-1",
      send: fakeSend,
    });

    const resp = await client.messages.create({
      model: "us.anthropic.claude-opus-4-8",
      max_tokens: 64,
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      output_config: { effort: "medium" },
      thinking: { type: "adaptive" },
    } as any);

    expect(capturedInput.modelId).toBe("us.anthropic.claude-opus-4-8");
    expect(capturedInput.contentType).toBe("application/json");
    const sentBody = JSON.parse(
      typeof capturedInput.body === "string"
        ? capturedInput.body
        : new TextDecoder().decode(capturedInput.body),
    );
    expect(sentBody.model).toBeUndefined();
    expect(sentBody.anthropic_version).toBe("bedrock-2023-05-31");
    expect(sentBody.max_tokens).toBe(64);
    expect(sentBody.output_config).toEqual({ effort: "medium" });
    expect(sentBody.thinking).toEqual({ type: "adaptive" });
    expect(sentBody.system).toEqual([{ type: "text", text: "sys" }]);

    expect(resp.content).toEqual([{ type: "text", text: "ok" }]);
    expect(resp.stop_reason).toBe("end_turn");
    const converted = convertResponse(resp);
    expect(converted.text).toBe("ok");
  });

  test("does not mutate the caller's body object", async () => {
    const fakeSend = async () =>
      fakeAwsResponse({
        id: "m",
        type: "message",
        role: "assistant",
        model: "x",
        content: [{ type: "text", text: "y" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const client = createBedrockMessagesClient("us.anthropic.claude-opus-4-8", {
      region: "us-east-1",
      send: fakeSend,
    });
    const body = { model: "us.anthropic.claude-opus-4-8", max_tokens: 8, messages: [] } as any;
    await client.messages.create(body);
    expect(body.model).toBe("us.anthropic.claude-opus-4-8");
    expect(body.anthropic_version).toBeUndefined();
  });
});

describe("createAnthropicClient auth-mode selection", () => {
  test("Bedrock mode constructs a client without ANTHROPIC_API_KEY", () => {
    withEnv(
      {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
        ANTHROPIC_API_KEY: undefined,
      },
      () => {
        // Must not throw the API-key error; returns a usable client.
        const client = createAnthropicClient("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
        expect(typeof client.chat).toBe("function");
        expect(client.userMessage("hi")).toEqual({ role: "user", content: "hi" });
      },
    );
  });

  test("Bedrock mode throws when AWS_REGION is unset", () => {
    withEnv(
      {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      () => {
        expect(() => createAnthropicClient("us.anthropic.claude-opus-4-8")).toThrow(/AWS_REGION/);
      },
    );
  });

  test("direct-API mode still requires ANTHROPIC_API_KEY", () => {
    withEnv(
      {
        CLAUDE_CODE_USE_BEDROCK: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      () => {
        expect(() => createAnthropicClient("claude-sonnet-4-6")).toThrow(/ANTHROPIC_API_KEY/);
      },
    );
  });
});

describe("anthropicToolResultMessages", () => {
  test("creates tool_result content blocks", () => {
    const calls = [
      { id: "toolu_abc", name: "screenshot", arguments: {} },
      { id: "toolu_def", name: "click", arguments: { x: 10, y: 20 } },
    ];
    const results = [
      { kind: "text" as const, text: "base64data" },
      { kind: "text" as const, text: "clicked" },
    ];

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
    const results = [{ kind: "text" as const, text: undefined as unknown as string }];

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
      kind: "image" as const,
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
      kind: "image" as const,
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

describe("convertResponse stop_reason pass-through", () => {
  function makeMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello", citations: null }] as unknown as Anthropic.Message["content"],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      } as unknown as Anthropic.Message["usage"],
      ...overrides,
    } as Anthropic.Message;
  }

  test("end_turn passes through", () => {
    const r = convertResponse(makeMessage({ stop_reason: "end_turn" }));
    expect(r.stopReason).toBe("end_turn");
  });

  test("tool_use passes through", () => {
    const r = convertResponse(makeMessage({ stop_reason: "tool_use" }));
    expect(r.stopReason).toBe("tool_use");
  });

  test("max_tokens passes through (not collapsed to end_turn)", () => {
    const r = convertResponse(makeMessage({ stop_reason: "max_tokens" }));
    expect(r.stopReason).toBe("max_tokens");
  });

  test("stop_sequence passes through", () => {
    const r = convertResponse(makeMessage({ stop_reason: "stop_sequence" }));
    expect(r.stopReason).toBe("stop_sequence");
  });

  test("pause_turn passes through", () => {
    const r = convertResponse(makeMessage({ stop_reason: "pause_turn" }));
    expect(r.stopReason).toBe("pause_turn");
  });

  test("null stop_reason falls back to end_turn", () => {
    const r = convertResponse(makeMessage({ stop_reason: null }));
    expect(r.stopReason).toBe("end_turn");
  });
});

describe("convertResponse non-message body guard", () => {
  // Bedrock (and a misconfigured proxy in front of it) can return a 200 whose
  // body is NOT an Anthropic Message — e.g. an AWS Coral error envelope
  // `{ Output: { __type: "...UnknownOperationException" }, Version: "1.0" }`.
  // The SDK does not throw on these, so convertResponse used to crash with the
  // opaque "undefined is not an object (evaluating 'response.content.filter')",
  // which destroyed the real error in the run log. Guard: throw a clear,
  // payload-free error naming the situation so the actual cause is diagnosable.
  test("throws a clear error when response.content is missing (AWS error envelope)", () => {
    const awsEnvelope = {
      Output: { __type: "com.amazon.coral.service#UnknownOperationException" },
      Version: "1.0",
    } as unknown as Anthropic.Message;
    expect(() => convertResponse(awsEnvelope)).toThrow(/response has no message content/i);
  });

  test("the error does not leak the raw response body", () => {
    const awsEnvelope = {
      Output: { __type: "com.amazon.coral.service#UnknownOperationException" },
      Version: "1.0",
    } as unknown as Anthropic.Message;
    try {
      convertResponse(awsEnvelope);
      throw new Error("expected convertResponse to throw");
    } catch (err) {
      const msg = (err as Error).message;
      // Names the offending shape (top-level keys) for diagnosis, but does not
      // dump the full body (which could carry sensitive values from a proxy).
      expect(msg).toContain("Output");
      expect(msg).not.toContain("UnknownOperationException");
    }
  });
});

describe("convertResponse cache token capture", () => {
  function makeMessageWithUsage(usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  }): Anthropic.Message {
    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello", citations: null }] as unknown as Anthropic.Message["content"],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: usage as unknown as Anthropic.Message["usage"],
    } as Anthropic.Message;
  }

  test("captures cache_creation_input_tokens", () => {
    const r = convertResponse(
      makeMessageWithUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 750,
        cache_read_input_tokens: 0,
      }),
    );
    expect(r.usage.cacheCreationInputTokens).toBe(750);
    expect(r.usage.cacheReadInputTokens).toBe(0);
  });

  test("captures cache_read_input_tokens", () => {
    const r = convertResponse(
      makeMessageWithUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 900,
      }),
    );
    expect(r.usage.cacheReadInputTokens).toBe(900);
    expect(r.usage.cacheCreationInputTokens).toBe(0);
  });

  test("rawUsage carries the provider usage object verbatim for the cost sidecar", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 750,
      cache_read_input_tokens: 0,
    };
    const r = convertResponse(makeMessageWithUsage(usage));
    expect(r.rawUsage).toEqual(usage);
  });

  test("treats null cache values as undefined", () => {
    const r = convertResponse(
      makeMessageWithUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
    );
    expect(r.usage.cacheCreationInputTokens).toBeUndefined();
    expect(r.usage.cacheReadInputTokens).toBeUndefined();
  });

  test("preserves input/output tokens", () => {
    const r = convertResponse(
      makeMessageWithUsage({
        input_tokens: 123,
        output_tokens: 45,
      }),
    );
    expect(r.usage.inputTokens).toBe(123);
    expect(r.usage.outputTokens).toBe(45);
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
