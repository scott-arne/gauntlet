import { describe, test, expect, afterEach } from "bun:test";
import { runAgent } from "../../src/agent/agent";
import { TUIAdapter } from "../../src/adapters/tui/adapter";
import { EvidenceLogger } from "../../src/evidence/logger";
import { makeRunId } from "../../src/util/id";
import type { AgentResponse } from "../../src/models/provider";
import { mkdtempSync, readFileSync, existsSync } from "fs";
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

// End-to-end smoke for the capture-as-evidence flow. Drives the colored
// alphabet fixture through the real agent loop, then inspects the run
// directory to confirm:
//   - run.jsonl contains a tool_result with text = "captures/000.ansi"
//   - captures/000.ansi exists with the raw ANSI from tmux
//   - captures/000.json parses to a Capture with the expected cols/rows
// This is the guardrail against regressions that silently inline ANSI
// back into run.jsonl.
describe.skipIf(!hasTmux)("TUI adapter e2e — colored-alphabet capture evidence", () => {
  let adapter: TUIAdapter | null = null;

  afterEach(async () => {
    if (adapter) {
      try {
        await adapter.close();
      } catch {
        // session may already be dead
      }
      adapter = null;
    }
  });

  test("read_screen writes capture files and references them from run.jsonl", async () => {
    const card = loadStory("colored-alphabet-pass.md");
    adapter = new TUIAdapter();
    const logDir = mkdtempSync(join(tmpdir(), "gauntlet-cap-alpha-"));
    const logger = new EvidenceLogger(logDir);

    const steps: AgentResponse[] = [
      step("call_1", "read_screen", {}),
      report(
        "pass",
        "agent read the screen",
        "Read ANSI-rendered letters and verified the color mapping",
      ),
    ];
    const client = makeScriptedClient(steps, 500);

    const fixturePath = join(import.meta.dir, "..", "fixtures", "tui", "colored-alphabet.sh");
    await adapter.start(`sh ${fixturePath}`);
    const result = await runAgent(card, adapter, client, logger, undefined, {
      runId: makeRunId(card.id),
      budgetMs: 60_000,
      reflectionInterval: 0,
    });

    // Agent flow succeeded end-to-end.
    expect(result.status).toBe("pass");
    expect(result.evidence.captures).toEqual(["captures/000.ansi"]);

    // Both files on disk.
    expect(existsSync(join(logDir, "captures/000.ansi"))).toBe(true);
    expect(existsSync(join(logDir, "captures/000.json"))).toBe(true);

    // The `.ansi` ground truth carries the letters.
    const ansi = readFileSync(join(logDir, "captures/000.ansi"), "utf-8");
    expect(ansi).toContain("A");
    expect(ansi).toContain("H");

    // The `.json` parses to the expected shape.
    const parsed = JSON.parse(readFileSync(join(logDir, "captures/000.json"), "utf-8"));
    expect(parsed.cols).toBe(120);
    expect(parsed.rows).toBe(40);
    expect(parsed.cells).toHaveLength(40);
    expect(parsed.cells[0]).toHaveLength(120);
    // The first letters are colored — parser should surface fg on them.
    const firstRow = parsed.cells[0];
    const colored = firstRow.filter((c: { fg?: string }) => c.fg);
    expect(colored.length).toBeGreaterThan(0);

    // run.jsonl's tool_result for read_screen uses the path, not the ANSI.
    const jsonl = readFileSync(join(logDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const toolResult = jsonl.find(
      (e) => e.type === "tool_result" && e.name === "read_screen",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult.text).toBe("captures/000.ansi");
    // Defense: the inline ANSI should NOT appear in the tool_result row.
    expect(JSON.stringify(toolResult)).not.toContain("\\u001b[31m");

    // A tui_capture anomaly event was logged — the broadcaster forwards
    // this to WS clients subscribed to the run.
    const captureEvent = jsonl.find(
      (e) => e.type === "event" && e.name === "tui_capture",
    );
    expect(captureEvent).toBeDefined();
    expect(captureEvent.path).toBe("captures/000.ansi");
    expect(captureEvent.cols).toBe(120);
    expect(captureEvent.rows).toBe(40);
  }, 15_000);
});
