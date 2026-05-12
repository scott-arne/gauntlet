import { describe, test, expect } from "bun:test";
import { runAgent } from "../../src/agent/agent";
import { EvidenceLogger } from "../../src/evidence/logger";
import { makeRunId } from "../../src/util/id";
import type { AgentResponse } from "../../src/models/provider";
import { mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadStory,
  step,
  report,
  makeScriptedClient,
  withTimeout,
  isChromeUnavailable,
} from "./helpers";
import { pickFreePort } from "../../src/util/pick-free-port";

const FIXTURE_HTML = `<!DOCTYPE html>
<html><body>
  <form method="POST" action="/submit">
    <button type="submit">submit</button>
  </form>
</body></html>`;

async function serveFormFixture() {
  return Bun.serve({
    port: await pickFreePort(),
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" && req.method === "GET") {
        return new Response(FIXTURE_HTML, {
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.pathname === "/submit" && req.method === "POST") {
        return new Response(null, {
          status: 303,
          headers: { location: "/" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

describe("Web e2e — form-post + return_screenshot (PRI-1517 T2b)", () => {
  test(
    "click(button, return_screenshot:true) returns a truthful result well under the 30s regression",
    async () => {
      let WebAdapter: any;
      try {
        const mod = await import("../../src/adapters/web/adapter");
        WebAdapter = mod.WebAdapter;
      } catch {
        console.log("Skipping web e2e: chrome-ws-lib not available");
        return;
      }

      const card = loadStory("click-and-screenshot-pass.md");
      const logDir = mkdtempSync(join(tmpdir(), "gauntlet-pri1517-"));
      const logger = new EvidenceLogger(logDir);
      const server = await serveFormFixture();
      const adapter = new WebAdapter();

      const steps: AgentResponse[] = [
        step("call_1", "click", { selector: "button", return_screenshot: true }),
        report(
          "pass",
          "Action reported truthfully",
          "Click returned a usable result whether or not the screenshot succeeded."
        ),
      ];

      const client = makeScriptedClient(steps);

      try {
        await withTimeout(
          adapter.start(`http://localhost:${server.port}`),
          10_000,
          "adapter.start()"
        );
        const t0 = Date.now();
        const result = await withTimeout(
          runAgent(card, adapter, client, logger, undefined, {
            runId: makeRunId(card.id),
            budgetMs: 60_000,
            reflectionInterval: 0,
          }),
          15_000,
          "runAgent()"
        );
        const elapsed = Date.now() - t0;

        // The click must have returned within ~6s wall-time. runAgent
        // adds some overhead; pick a conservative envelope of 8s.
        expect(elapsed).toBeLessThan(8_000);
        expect(result.status).toBe("pass");

        // Inspect the click's tool result via the evidence log.
        // EvidenceLogger has no readEvents() method — read run.jsonl
        // directly per the existing convention (test/e2e/tui-colored-
        // alphabet.test.ts:89-92).
        const events = readFileSync(join(logDir, "run.jsonl"), "utf-8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const clickResult = events.find(
          (e: any) => e.type === "tool_result" && e.name === "click"
        );
        expect(clickResult).toBeDefined();
        expect(clickResult.text).toMatch(/^clicked /);
        // Acceptable post-fix outcomes: image present (race won) XOR
        // text includes the skip note (race lost). Exactly one must
        // hold — both true would mean a stale skip-note appended even
        // after imagery was captured (a real bug class), and both
        // false would mean the truthful-result contract failed.
        const hasImage = clickResult.image !== undefined;
        const hasSkipNote = /\(screenshot unavailable: /.test(clickResult.text);
        expect(hasImage !== hasSkipNote).toBe(true); // exactly one of the two
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
    20_000
  );
});
