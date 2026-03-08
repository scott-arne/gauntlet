import { describe, test, expect, afterEach } from "bun:test";
import { runAgent } from "../../src/agent/agent";
import { TUIAdapter } from "../../src/adapters/tui/adapter";
import { EvidenceLogger } from "../../src/evidence/logger";
import { parseStoryCard } from "../../src/format/story-card";
import type {
  LLMClient,
  ToolCall,
  ToolResult,
  AgentResponse,
} from "../../src/models/provider";
import { join } from "path";
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";

const STORIES_DIR = join(import.meta.dir, "../fixtures/stories");

function loadStory(filename: string) {
  return parseStoryCard(readFileSync(join(STORIES_DIR, filename), "utf-8"));
}

function step(
  id: string,
  name: string,
  args: Record<string, unknown>
): AgentResponse {
  return {
    text: `Executing ${name}`,
    toolCalls: [{ id, name, arguments: args }],
    stopReason: "tool_use",
    rawAssistantMessage: { role: "assistant", content: `step ${id}` },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function report(
  status: string,
  summary: string,
  reasoning: string
): AgentResponse {
  return {
    text: summary,
    toolCalls: [
      {
        id: "call_report",
        name: "report_result",
        arguments: { status, summary, reasoning },
      },
    ],
    stopReason: "tool_use",
    rawAssistantMessage: { role: "assistant", content: "reporting" },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function makeScriptedClient(steps: AgentResponse[]): LLMClient {
  let callIndex = 0;

  return {
    async chat() {
      await Bun.sleep(500);
      const response = steps[callIndex++];
      if (!response) throw new Error("No more scripted responses");
      return response;
    },
    userMessage(content: string) {
      return { role: "user", content };
    },
    toolResultMessages(calls: ToolCall[], results: ToolResult[]) {
      return calls.map((call, i) => ({
        role: "tool_result",
        tool_call_id: call.id,
        content: results[i].text,
      }));
    },
  };
}

const hasTmux = (() => {
  try {
    return Bun.spawnSync(["tmux", "-V"]).exitCode === 0;
  } catch {
    return false;
  }
})();

const hasNano = (() => {
  try {
    return Bun.spawnSync(["which", "nano"]).exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTmux || !hasNano)("TUI adapter e2e — nano editor", () => {
  let adapter: TUIAdapter | null = null;
  let tempFile: string | null = null;

  afterEach(async () => {
    if (adapter) {
      try {
        await adapter.close();
      } catch {
        // session may already be dead
      }
      adapter = null;
    }
    if (tempFile) {
      try {
        unlinkSync(tempFile);
      } catch {
        // file may already be gone
      }
      tempFile = null;
    }
  });

  test("pass: user can open, type, and save in nano", async () => {
    const card = loadStory("nano-open-save-pass.md");
    adapter = new TUIAdapter();
    const logDir = mkdtempSync(join(tmpdir(), "vet-nano-save-"));
    const logger = new EvidenceLogger(logDir);

    tempFile = join(tmpdir(), `vet-nano-${Date.now()}.txt`);
    writeFileSync(tempFile, "initial content\n");

    const steps: AgentResponse[] = [
      step("call_1", "read_screen", {}),
      step("call_2", "type", { text: "Hello from vet!" }),
      step("call_3", "read_screen", {}),
      step("call_4", "press", { key: "Ctrl+O" }),
      step("call_5", "read_screen", {}),
      step("call_6", "press", { key: "Enter" }),
      step("call_7", "read_screen", {}),
      report(
        "pass",
        "nano opens, accepts typed text, and saves files",
        "Opened file with initial content, typed text, used Ctrl+O to save, confirmed filename"
      ),
    ];

    const client = makeScriptedClient(steps);

    await adapter.start(`nano ${tempFile}`);
    const result = await runAgent(card, adapter, client, logger);

    expect(result.status).toBe("pass");
    expect(result.scenario).toBe("nano-open-save-pass");
  }, 15_000);

  test("fail: nano has no tabs", async () => {
    const card = loadStory("nano-tabs-fail.md");
    adapter = new TUIAdapter();
    const logDir = mkdtempSync(join(tmpdir(), "vet-nano-tabs-"));
    const logger = new EvidenceLogger(logDir);

    tempFile = join(tmpdir(), `vet-nano-${Date.now()}.txt`);
    writeFileSync(tempFile, "some content\n");

    const steps: AgentResponse[] = [
      step("call_1", "read_screen", {}),
      report(
        "fail",
        "nano does not support tabbed editing",
        "The screen shows a single file view with no tab bar or tab switching interface"
      ),
    ];

    const client = makeScriptedClient(steps);

    await adapter.start(`nano ${tempFile}`);
    const result = await runAgent(card, adapter, client, logger);

    expect(result.status).toBe("fail");
    expect(result.scenario).toBe("nano-tabs-fail");
  }, 15_000);
});
