import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { runRoutes } from "../../../src/api/routes/run";
import { gauntletPath } from "../../../src/paths";
import type { AppConfig } from "../../../src/config";
import type { LLMClient } from "../../../src/models/provider";

function stubClient(): LLMClient {
  // Non-network client. The detached executeRun may call chat() — return
  // an end_turn so the background task terminates quickly. The test's
  // assertion is on disk state at handler return, not on the
  // background agent loop, so this body is essentially irrelevant.
  return {
    async chat() {
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  } as unknown as LLMClient;
}

describe("POST /run/:id — snapshot", () => {
  test("writes <runDir>/inputs/{story.md,context/} synchronously in the handler", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-api-snap-"));
    try {
      const storiesDir = gauntletPath(projectRoot, "stories");
      mkdirSync(storiesDir, { recursive: true });
      const storyBody =
        "---\nid: snap-story\ntitle: Snap\n---\n# Snap\n\nBody.\n";
      writeFileSync(join(storiesDir, "snap-story.md"), storyBody);

      const ctxRoot = gauntletPath(projectRoot, "context");
      mkdirSync(join(ctxRoot, "matt"), { recursive: true });
      writeFileSync(join(ctxRoot, "matt", "identity.md"), "name: matt");

      const config: AppConfig = {
        projectRoot,
        // "claude-stub" (vs "stub") so resolveProvider() in the handler
        // succeeds (anthropic branch). clientFactory below still short-
        // circuits createClient, so no real network client is built.
        models: { agent: "claude-stub", available: [] },
        sources: { defaultChrome: "default" },
        defaultChrome: undefined,
        defaultViewport: undefined,
        defaultBudgetMs: 60_000,
        defaultMaxStuckRetries: 5,
      } as unknown as AppConfig;

      const app = new Hono();
      app.route(
        "/run",
        runRoutes(config, undefined, undefined, undefined, undefined, undefined, () => stubClient()),
      );

      const res = await app.request("/run/snap-story", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "cli:echo", adapter: "cli" }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { runs: Array<{ runId: string }> };

      // Snapshot is synchronous in the request handler — so it MUST be
      // present as soon as the 202 is returned, regardless of what the
      // detached executeRun goes on to do (including failing).
      const runDir = gauntletPath(projectRoot, "results", body.runs[0].runId);
      expect(existsSync(join(runDir, "inputs", "story.md"))).toBe(true);
      expect(readFileSync(join(runDir, "inputs", "story.md"), "utf-8")).toBe(storyBody);
      expect(readFileSync(join(runDir, "inputs", "context", "matt", "identity.md"), "utf-8"))
        .toBe("name: matt");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
