import { describe, test, expect, afterEach } from "bun:test";
import { runAgent } from "../../src/agent/agent";
import { TUIAdapter } from "../../src/adapters/tui/adapter";
import { EvidenceLogger } from "../../src/evidence/logger";
import { makeRunId } from "../../src/util/id";
import type { AgentResponse } from "../../src/models/provider";
import { mkdtempSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadStory, step, report, makeScriptedClient } from "./helpers";

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
    const logDir = mkdtempSync(join(tmpdir(), "gauntlet-nano-save-"));
    const logger = new EvidenceLogger(logDir);

    tempFile = join(tmpdir(), `gauntlet-nano-${Date.now()}.txt`);
    writeFileSync(tempFile, "initial content\n");

    const steps: AgentResponse[] = [
      step("call_1", "read_screen", {}),
      step("call_2", "type", { text: "Hello from gauntlet!" }),
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

    const client = makeScriptedClient(steps, 500);

    await adapter.start(`nano ${tempFile}`);
    const result = await runAgent(card, adapter, client, logger, undefined, { runId: makeRunId(card.id), budgetMs: 60_000, reflectionInterval: 0 });

    expect(result.status).toBe("pass");
    expect(result.scenario).toBe("nano-open-save-pass");
  }, 15_000);

  test("fail: nano has no tabs", async () => {
    const card = loadStory("nano-tabs-fail.md");
    adapter = new TUIAdapter();
    const logDir = mkdtempSync(join(tmpdir(), "gauntlet-nano-tabs-"));
    const logger = new EvidenceLogger(logDir);

    tempFile = join(tmpdir(), `gauntlet-nano-${Date.now()}.txt`);
    writeFileSync(tempFile, "some content\n");

    const steps: AgentResponse[] = [
      step("call_1", "read_screen", {}),
      report(
        "fail",
        "nano does not support tabbed editing",
        "The screen shows a single file view with no tab bar or tab switching interface"
      ),
    ];

    const client = makeScriptedClient(steps, 500);

    await adapter.start(`nano ${tempFile}`);
    const result = await runAgent(card, adapter, client, logger, undefined, { runId: makeRunId(card.id), budgetMs: 60_000, reflectionInterval: 0 });

    expect(result.status).toBe("fail");
    expect(result.scenario).toBe("nano-tabs-fail");
  }, 15_000);
});
