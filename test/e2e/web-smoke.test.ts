import { describe, test, expect } from "bun:test";
import { runAgent } from "../../src/agent/agent";
import { EvidenceLogger } from "../../src/evidence/logger";
import { makeRunId } from "../../src/util/id";
import type { LLMClient, ToolCall, ToolResult } from "../../src/models/provider";
import type { StoryCard } from "../../src/format/story-card";
import { mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { withTimeout, isChromeUnavailable } from "./helpers";
import { pickFreePort } from "../../src/util/pick-free-port";

const TEST_PAGE = join(import.meta.dir, "../fixtures/test-page.html");

describe("Web e2e smoke test", () => {
  test(
    "agent can interact with a web page",
    async () => {
      // Dynamic import so test file doesn't fail if chrome-ws-lib has issues
      let WebAdapter: any;
      try {
        const mod = await import("../../src/adapters/web/adapter");
        WebAdapter = mod.WebAdapter;
      } catch (err) {
        console.log("Skipping web e2e: chrome-ws-lib not available");
        return;
      }

      const outDir = mkdtempSync(join(tmpdir(), "gauntlet-e2e-web-"));
      const logger = new EvidenceLogger(outDir);

      // Serve the test page
      const server = Bun.serve({
        port: await pickFreePort(),
        fetch() {
          const html = readFileSync(TEST_PAGE, "utf-8");
          return new Response(html, {
            headers: { "Content-Type": "text/html" },
          });
        },
      });

      const adapter = new WebAdapter();
      let callCount = 0;

      // Scripted mock client: screenshot -> type name -> click button -> extract greeting -> report
      const client: LLMClient = {
        async chat() {
          callCount++;
          switch (callCount) {
            case 1:
              return {
                text: "Taking a screenshot",
                toolCalls: [
                  { id: "tc_1", name: "screenshot", arguments: {} },
                ],
                stopReason: "tool_use" as const,
                rawAssistantMessage: { role: "assistant", turn: 1 },
                usage: { inputTokens: 0, outputTokens: 0 },
              };
            case 2:
              return {
                text: "Typing a name",
                toolCalls: [
                  {
                    id: "tc_2",
                    name: "type",
                    arguments: { text: "Alice", selector: "#name" },
                  },
                ],
                stopReason: "tool_use" as const,
                rawAssistantMessage: { role: "assistant", turn: 2 },
                usage: { inputTokens: 0, outputTokens: 0 },
              };
            case 3:
              return {
                text: "Clicking greet button",
                toolCalls: [
                  {
                    id: "tc_3",
                    name: "click",
                    arguments: { selector: "button" },
                  },
                ],
                stopReason: "tool_use" as const,
                rawAssistantMessage: { role: "assistant", turn: 3 },
                usage: { inputTokens: 0, outputTokens: 0 },
              };
            case 4:
              return {
                text: "Extracting greeting",
                toolCalls: [
                  {
                    id: "tc_4",
                    name: "extract",
                    arguments: { selector: "#greeting" },
                  },
                ],
                stopReason: "tool_use" as const,
                rawAssistantMessage: { role: "assistant", turn: 4 },
                usage: { inputTokens: 0, outputTokens: 0 },
              };
            case 5:
              return {
                text: "Reporting result",
                toolCalls: [
                  {
                    id: "tc_5",
                    name: "report_result",
                    arguments: {
                      status: "pass",
                      summary: "Greeting page works",
                      reasoning:
                        "Typed Alice, clicked Greet, saw Hello Alice!",
                    },
                  },
                ],
                stopReason: "tool_use" as const,
                rawAssistantMessage: { role: "assistant", turn: 5 },
                usage: { inputTokens: 0, outputTokens: 0 },
              };
            default:
              throw new Error(`Unexpected call ${callCount}`);
          }
        },
        userMessage(content: string) {
          return { role: "user", content };
        },
        toolResultMessages(calls: ToolCall[], results: ToolResult[]) {
          return calls.map((c, i) => ({
            role: "tool",
            id: c.id,
            content: results[i].text,
          }));
        },
      };

      try {
        await withTimeout(
          adapter.start(`http://localhost:${server.port}`),
          10_000,
          "adapter.start()"
        );
        const card = makeCard();
        const result = await withTimeout(
          runAgent(card, adapter, client, logger, undefined, { runId: makeRunId(card.id), budgetMs: 60_000, reflectionInterval: 0 }),
          15_000,
          "runAgent()"
        );
        expect(result.status).toBe("pass");
      } catch (err: any) {
        if (isChromeUnavailable(err)) {
          console.log(`Skipping web e2e: ${err.message}`);
          return;
        }
        throw err;
      } finally {
        await adapter.close();
        server.stop();
      }
    },
    30_000
  );
});

function makeCard(): StoryCard {
  return {
    id: "web-smoke",
    title: "Greeting page works",
    status: "ready",
    tags: [],
    description: "User can enter name and see greeting",
    acceptanceCriteria: ["Greeting appears after clicking button"],
    raw: "",
  };
}
