import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLIAdapter } from "../../src/adapters/cli/adapter";
import { EvidenceLogger } from "../../src/evidence/logger";

function pidStillAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);  // signal 0 = check only
    return true;
  } catch {
    return false;
  }
}

function readRunJsonl(dir: string): string {
  const path = join(dir, "run.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

let runDir: string;
let logger: EvidenceLogger;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "cli-adapter-"));
  logger = new EvidenceLogger(runDir);
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe("CLIAdapter — shell session", () => {
  test("start() creates <runDir>/scratch and runs bash there", async () => {
    const adapter = new CLIAdapter({ contextRoot: undefined, runDir });
    await adapter.start("docker");
    try {
      const scratch = join(runDir, "scratch");
      expect(existsSync(scratch)).toBe(true);
      // Verify the shell's cwd is the scratch dir.
      await adapter.executeTool("type", { text: "pwd\n" }, logger);
      // Give bash a beat to respond.
      await new Promise((r) => setTimeout(r, 200));
      const out = await adapter.executeTool("read_output", {}, logger);
      expect(out.text).toContain(scratch);
    } finally {
      await adapter.close();
    }
  });

  test("describeTarget mentions the shell and the target command", () => {
    const adapter = new CLIAdapter({ contextRoot: undefined, runDir });
    const msg = adapter.describeTarget("docker");
    expect(msg).toContain("bash");
    expect(msg).toContain("docker");
    expect(msg).toContain("exit");  // tells the agent to type exit when done
  });

  test("describeTarget omits the target sentence when target is empty", () => {
    const adapter = new CLIAdapter({ contextRoot: undefined, runDir });
    const msg = adapter.describeTarget("");
    expect(msg).toContain("bash");
    expect(msg).not.toMatch(/command you are exercising/i);
  });
});

describe("CLIAdapter — close escalation", () => {
  test("graceful exit: \\nexit\\n triggers no SIGHUP or SIGKILL", async () => {
    const adapter = new CLIAdapter({ contextRoot: undefined, runDir, logger });
    await adapter.start("");
    // Read any startup banner before close so we measure the close path.
    // 300ms is generous insurance against slow CI runners.
    await new Promise((r) => setTimeout(r, 300));
    await adapter.close();
    const jsonl = readRunJsonl(runDir);
    expect(jsonl).not.toContain("cli_shell_force_killed");
  });

  test("orphan reap: backgrounded sleep is gone after close", async () => {
    const adapter = new CLIAdapter({ contextRoot: undefined, runDir, logger });
    await adapter.start("");
    await new Promise((r) => setTimeout(r, 300));
    await adapter.executeTool(
      "type",
      { text: "sleep 999 & echo PID=$!\n" },
      logger,
    );
    await new Promise((r) => setTimeout(r, 300));
    const out = await adapter.executeTool("read_output", {}, logger);
    const match = out.text.match(/PID=(\d+)/);
    expect(match).not.toBeNull();
    const childPid = Number(match![1]);
    expect(pidStillAlive(childPid)).toBe(true);

    await adapter.close();
    // Give the OS a beat to finalize the reap.
    await new Promise((r) => setTimeout(r, 100));
    expect(pidStillAlive(childPid)).toBe(false);
  });

  test("half-typed line: close still exits cleanly", async () => {
    const adapter = new CLIAdapter({ contextRoot: undefined, runDir, logger });
    await adapter.start("");
    await new Promise((r) => setTimeout(r, 300));
    // Type a partial command with no trailing newline.
    await adapter.executeTool("type", { text: "echo partial" }, logger);
    await new Promise((r) => setTimeout(r, 100));
    await adapter.close();
    const jsonl = readRunJsonl(runDir);
    expect(jsonl).not.toContain("cli_shell_force_killed");
  });
});

describe("CLIAdapter — fallback escalation", () => {
  test("SIGHUP-suffices: bash busy with a foreground sleep exits on SIGHUP", async () => {
    const adapter = new CLIAdapter({ contextRoot: undefined, runDir, logger });
    await adapter.start("");
    await new Promise((r) => setTimeout(r, 300));
    // Put bash into a foreground sleep. While sleep runs, bash isn't
    // reading stdin, so \nexit\n piles up unprocessed. SIGHUP terminates
    // bash (default action), satisfying the fallback path.
    await adapter.executeTool(
      "type",
      { text: "sleep 60\n" },
      logger,
    );
    await new Promise((r) => setTimeout(r, 200));

    await adapter.close();

    const jsonl = readRunJsonl(runDir);
    expect(jsonl).toContain("cli_shell_force_killed");
    expect(jsonl).toContain('"escalationStep":"sighup"');
  });

  test("SIGKILL fallback: bash with SIGHUP trapped + foreground sleep gets SIGKILL", async () => {
    const adapter = new CLIAdapter({ contextRoot: undefined, runDir, logger });
    await adapter.start("");
    await new Promise((r) => setTimeout(r, 300));
    // Trap SIGHUP to ignore, then enter a foreground sleep. Neither
    // graceful exit nor SIGHUP gets a response — only SIGKILL works.
    await adapter.executeTool(
      "type",
      { text: "trap '' HUP\nsleep 60\n" },
      logger,
    );
    await new Promise((r) => setTimeout(r, 200));

    await adapter.close();

    const jsonl = readRunJsonl(runDir);
    expect(jsonl).toContain("cli_shell_force_killed");
    expect(jsonl).toContain('"escalationStep":"sigkill"');
  });
});

describe("CLIAdapter — prompt-response compatibility", () => {
  test("agent can drive an interactive prompt-and-answer script", async () => {
    const scratch = join(runDir, "scratch");
    mkdirSync(scratch, { recursive: true });
    const scriptPath = join(scratch, "prompts.sh");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        'read -p "name: " name',
        'read -p "color: " color',
        'echo "got: $name / $color"',
      ].join("\n") + "\n",
    );
    chmodSync(scriptPath, 0o755);

    const adapter = new CLIAdapter({ contextRoot: undefined, runDir, logger });
    await adapter.start("prompts.sh");
    try {
      await adapter.executeTool("type", { text: "./prompts.sh\n" }, logger);
      await new Promise((r) => setTimeout(r, 200));
      await adapter.executeTool("type", { text: "fred\n" }, logger);
      await new Promise((r) => setTimeout(r, 100));
      await adapter.executeTool("type", { text: "red\n" }, logger);
      await new Promise((r) => setTimeout(r, 200));
      const out = await adapter.executeTool("read_output", {}, logger);
      expect(out.text).toContain("got: fred / red");
    } finally {
      await adapter.close();
    }
  });
});
