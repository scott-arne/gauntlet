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

describe("CLIAdapter — close cleanup", () => {
  test("orphan reap: backgrounded sleep is gone after close and event fires", async () => {
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
    await new Promise((r) => setTimeout(r, 100));
    expect(pidStillAlive(childPid)).toBe(false);

    const jsonl = readRunJsonl(runDir);
    expect(jsonl).toContain("cli_shell_descendants_reaped");
    expect(jsonl).not.toContain("cli_shell_force_killed");
  });

  test("no event emitted when there are no descendants to reap", async () => {
    const adapter = new CLIAdapter({ contextRoot: undefined, runDir, logger });
    await adapter.start("");
    await new Promise((r) => setTimeout(r, 200));
    await adapter.close();
    const jsonl = readRunJsonl(runDir);
    expect(jsonl).not.toContain("cli_shell_descendants_reaped");
    expect(jsonl).not.toContain("cli_shell_force_killed");
  });

  test("half-typed line: close still exits cleanly", async () => {
    const adapter = new CLIAdapter({ contextRoot: undefined, runDir, logger });
    await adapter.start("");
    await new Promise((r) => setTimeout(r, 300));
    await adapter.executeTool("type", { text: "echo partial" }, logger);
    await new Promise((r) => setTimeout(r, 100));
    // Should complete without throwing.
    await adapter.close();
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
