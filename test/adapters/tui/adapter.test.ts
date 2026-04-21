import { describe, test, expect, afterEach } from "bun:test";
import { TUIAdapter } from "../../../src/adapters/tui/adapter";
import { EvidenceLogger } from "../../../src/evidence/logger";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmuxAvailable = (() => {
  try {
    const result = Bun.spawnSync(["tmux", "-V"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!tmuxAvailable)("TUIAdapter", () => {
  let adapter: TUIAdapter | null = null;

  afterEach(async () => {
    if (adapter) {
      try {
        await adapter.close();
      } catch {
        // session may already be dead
      }
    }
    adapter = null;
  });

  test("starts process in tmux and reads output", async () => {
    adapter = new TUIAdapter();
    await adapter.start("sh -c \"echo 'hello from tmux'; sleep 10\"");
    await new Promise((r) => setTimeout(r, 500));
    const screen = await adapter.readScreen();
    expect(screen).toContain("hello from tmux");
  });

  test("sends keystrokes via tmux", async () => {
    adapter = new TUIAdapter();
    await adapter.start("bc -q");
    await new Promise((r) => setTimeout(r, 500));
    await adapter.type("2+3");
    await adapter.press("Enter");
    await new Promise((r) => setTimeout(r, 500));
    const screen = await adapter.readScreen();
    expect(screen).toContain("5");
  });

  test("close kills the tmux session", async () => {
    adapter = new TUIAdapter();
    await adapter.start("cat");
    const sessionName = adapter.sessionName;
    await adapter.close();
    const result = Bun.spawnSync(["tmux", "has-session", "-t", sessionName]);
    expect(result.exitCode).not.toBe(0);
    adapter = null; // already closed
  });

  test("executeTool dispatches correctly and returns expected results", async () => {
    adapter = new TUIAdapter();
    const logDir = mkdtempSync(join(tmpdir(), "gauntlet-tui-exec-"));
    const logger = new EvidenceLogger(logDir);

    await adapter.start("bc -q");
    await new Promise((r) => setTimeout(r, 300));

    const typeResult = await adapter.executeTool("type", { text: "4*5" }, logger);
    expect(typeResult.text).toBe("typed");

    const pressResult = await adapter.executeTool("press", { key: "Enter" }, logger);
    expect(pressResult.text).toBe("pressed");

    await new Promise((r) => setTimeout(r, 300));

    const result = await adapter.executeTool("read_screen", {}, logger);
    expect(result.text).toContain("20");

    // The adapter no longer writes tool-dispatch rows — the agent loop owns
    // tool_call/tool_result rows. run.jsonl written by the adapter alone
    // (without the agent) should contain zero tool_call rows.
    const logPath = join(logDir, "run.jsonl");
    const logExists = (() => { try { readFileSync(logPath); return true; } catch { return false; } })();
    if (logExists) {
      const logContent = readFileSync(logPath, "utf-8");
      expect(logContent).not.toContain('"type":"tool_call"');
    }
  });

  test("exposes tool definitions for the agent", () => {
    adapter = new TUIAdapter();
    const tools = adapter.toolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain("type");
    expect(names).toContain("press");
    expect(names).toContain("read_screen");
  });
});

describe("TUIAdapter context tool wiring", () => {
  test("includes `read` tool when context root is non-empty", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-read-"));
    try {
      mkdirSync(join(tmp, ".gauntlet", "context"), { recursive: true });
      writeFileSync(join(tmp, ".gauntlet", "context", "alice.md"), "A");
      const adapter = new TUIAdapter({
        contextRoot: join(tmp, ".gauntlet", "context"),
      });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).toContain("read");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
