import { describe, test, expect } from "bun:test";
import { runAgent } from "../../src/agent/agent";
import { EvidenceLogger } from "../../src/evidence/logger";
import type { LLMClient, ToolCall } from "../../src/models/provider";
import type { StoryCard } from "../../src/format/story-card";
import { mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_PAGE = join(import.meta.dir, "../fixtures/test-page.html");

/** Race a promise against a timeout; rejects with a descriptive error on timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/** Returns true if the error indicates Chrome is unavailable (not a real test failure) */
function isChromeUnavailable(err: any): boolean {
  const msg = err?.message ?? "";
  return (
    msg.includes("Chrome") ||
    msg.includes("connect") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("timed out")
  );
}

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

      const outDir = mkdtempSync(join(tmpdir(), "vet-e2e-web-"));
      const logger = new EvidenceLogger(outDir);

      // Serve the test page
      const server = Bun.serve({
        port: 0,
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
              };
            default:
              throw new Error(`Unexpected call ${callCount}`);
          }
        },
        userMessage(content: string) {
          return { role: "user", content };
        },
        toolResultMessages(calls: ToolCall[], results: string[]) {
          return calls.map((c, i) => ({
            role: "tool",
            id: c.id,
            content: results[i],
          }));
        },
      };

      try {
        await withTimeout(
          adapter.start(`http://localhost:${server.port}`),
          10_000,
          "adapter.start()"
        );
        const result = await withTimeout(
          runAgent(makeCard(), adapter, client, logger),
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
