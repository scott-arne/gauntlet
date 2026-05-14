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

  test("read_screen writes capture files and returns capturePath", async () => {
    adapter = new TUIAdapter();
    const logDir = mkdtempSync(join(tmpdir(), "gauntlet-tui-cap-"));
    const logger = new EvidenceLogger(logDir);

    await adapter.start("sh -c \"printf 'hello'; sleep 10\"");
    await new Promise((r) => setTimeout(r, 300));

    const result = await adapter.executeTool("read_screen", {}, logger);
    expect((result as { capturePath?: string }).capturePath).toBe("captures/000.ansi");
    // Raw ANSI text still flows to the LLM via result.text.
    expect(result.text).toContain("hello");

    // Both files on disk.
    expect(readFileSync(join(logDir, "captures/000.ansi"), "utf-8")).toContain("hello");
    const parsed = JSON.parse(readFileSync(join(logDir, "captures/000.json"), "utf-8"));
    expect(parsed.cols).toBe(120);
    expect(parsed.rows).toBe(40);
    expect(Array.isArray(parsed.cells)).toBe(true);

    // Second call increments the index.
    const result2 = await adapter.executeTool("read_screen", {}, logger);
    expect((result2 as { capturePath?: string }).capturePath).toBe("captures/001.ansi");
    expect(logger.captures).toEqual(["captures/000.ansi", "captures/001.ansi"]);

    // A tui_capture event row was appended for the broadcaster to pick up.
    const logContent = readFileSync(join(logDir, "run.jsonl"), "utf-8");
    expect(logContent).toContain('"name":"tui_capture"');
  });

  test("readScreen preserves ANSI escape sequences", async () => {
    adapter = new TUIAdapter();
    // Print a red "X" and a green "Y", then sleep so the session stays alive.
    // \x1b[31m = red fg, \x1b[32m = green fg, \x1b[0m = reset.
    await adapter.start(
      "sh -c \"printf '\\033[31mX\\033[0m\\033[32mY\\033[0m\\n'; sleep 10\""
    );
    await new Promise((r) => setTimeout(r, 300));
    const screen = await adapter.readScreen();
    // The characters come through.
    expect(screen).toContain("X");
    expect(screen).toContain("Y");
    // The color escapes survive (-e flag on capture-pane).
    expect(screen).toMatch(/\x1b\[[0-9;]*31/); // red fg somewhere
    expect(screen).toMatch(/\x1b\[[0-9;]*32/); // green fg somewhere
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

describe("TUIAdapter describeTarget", () => {
  test("frames the target as an already-running program and warns against retyping", () => {
    const adapter = new TUIAdapter();
    const msg = adapter.describeTarget("nano /tmp/foo.txt");
    expect(msg).toContain("nano /tmp/foo.txt");
    expect(msg.toLowerCase()).toContain("already running");
    expect(msg.toLowerCase()).toContain("do not retype");
  });
});

describe("TUIAdapter defaultViewport", () => {
  test("reports the tmux grid in character cells", () => {
    const adapter = new TUIAdapter();
    expect(adapter.defaultViewport()).toEqual({ width: 120, height: 40 });
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

  test("registers fetch_credential when contextRoot and credentialResolver set", () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const { join } = require("path");
    const ctxTmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-cred-ctx-"));
    const resTmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-cred-res-"));
    try {
      writeFileSync(join(ctxTmp, "alice.md"), "anything");
      const resolverPath = join(resTmp, "r.sh");
      writeFileSync(resolverPath, "#!/bin/sh\necho ok\n");
      chmodSync(resolverPath, 0o755);
      const adapter = new TUIAdapter({
        contextRoot: ctxTmp,
        credentialResolver: { path: resolverPath, timeoutMs: 1000, includeInTranscripts: false },
      });
      expect(adapter.toolDefinitions().map((t) => t.name)).toContain("fetch_credential");
    } finally {
      rmSync(ctxTmp, { recursive: true, force: true });
      rmSync(resTmp, { recursive: true, force: true });
    }
  });

  test("omits fetch_credential when credentialResolver is undefined", () => {
    const { mkdtempSync, writeFileSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const { join } = require("path");
    const ctxTmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-cred-ctx-"));
    try {
      writeFileSync(join(ctxTmp, "alice.md"), "anything");
      const adapter = new TUIAdapter({ contextRoot: ctxTmp });
      expect(adapter.toolDefinitions().map((t) => t.name)).not.toContain("fetch_credential");
    } finally {
      rmSync(ctxTmp, { recursive: true, force: true });
    }
  });

  test("omits fetch_credential when contextRoot is empty even if resolver is set", () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const { join } = require("path");
    const ctxTmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-cred-ctx-empty-"));
    const resTmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-cred-res-"));
    try {
      const resolverPath = join(resTmp, "r.sh");
      writeFileSync(resolverPath, "#!/bin/sh\necho ok\n");
      chmodSync(resolverPath, 0o755);
      const adapter = new TUIAdapter({
        contextRoot: ctxTmp,
        credentialResolver: { path: resolverPath, timeoutMs: 1000, includeInTranscripts: false },
      });
      expect(adapter.toolDefinitions().map((t) => t.name)).not.toContain("fetch_credential");
    } finally {
      rmSync(ctxTmp, { recursive: true, force: true });
      rmSync(resTmp, { recursive: true, force: true });
    }
  });
});
