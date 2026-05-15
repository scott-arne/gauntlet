import { describe, test, expect } from "bun:test";
import { runAgent } from "../../src/agent/agent";
import { CLIAdapter } from "../../src/adapters/cli/adapter";
import { EvidenceLogger } from "../../src/evidence/logger";
import { makeRunId } from "../../src/util/id";
import type { AgentResponse } from "../../src/models/provider";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadStory, step, report, makeScriptedClient } from "./helpers";

describe("CLI adapter e2e — bc calculator", () => {
  test("pass: bc performs arithmetic", async () => {
    const card = loadStory("bc-arithmetic-pass.md");
    const logDir = mkdtempSync(join(tmpdir(), "gauntlet-bc-arith-"));
    const adapter = new CLIAdapter({ runDir: logDir });
    const logger = new EvidenceLogger(logDir);

    // Under shell-as-session, the adapter spawns bash; the agent
    // launches bc by typing it into the shell.
    const steps: AgentResponse[] = [
      step("call_0", "type", { text: "bc -q\n" }),
      step("call_1", "type", { text: "2+3\n" }),
      step("call_2", "read_output", {}),
      step("call_3", "type", { text: "6*7\n" }),
      step("call_4", "read_output", {}),
      report("pass", "bc computes arithmetic correctly", "2+3=5 and 6*7=42"),
    ];

    const client = makeScriptedClient(steps);

    try {
      await adapter.start("bc -q");
      const result = await runAgent(card, adapter, client, logger, undefined, { runId: makeRunId(card.id), budgetMs: 60_000, reflectionInterval: 0 });

      expect(result.status).toBe("pass");
      expect(result.scenario).toBe("bc-arithmetic-pass");
    } finally {
      await adapter.close();
    }
  });

  test("fail: bc has no help command", async () => {
    const card = loadStory("bc-help-fail.md");
    const logDir = mkdtempSync(join(tmpdir(), "gauntlet-bc-help-"));
    const adapter = new CLIAdapter({ runDir: logDir });
    const logger = new EvidenceLogger(logDir);

    const steps: AgentResponse[] = [
      step("call_0", "type", { text: "bc -q\n" }),
      step("call_1", "type", { text: "help\n" }),
      step("call_2", "read_output", {}),
      report(
        "fail",
        "bc has no help command",
        "Typing help produced an error, not a help menu"
      ),
    ];

    const client = makeScriptedClient(steps);

    try {
      await adapter.start("bc -q");
      const result = await runAgent(card, adapter, client, logger, undefined, { runId: makeRunId(card.id), budgetMs: 60_000, reflectionInterval: 0 });

      expect(result.status).toBe("fail");
      expect(result.scenario).toBe("bc-help-fail");
    } finally {
      await adapter.close();
    }
  });
});
