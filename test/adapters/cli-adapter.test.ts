import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLIAdapter } from "../../src/adapters/cli/adapter";
import { EvidenceLogger } from "../../src/evidence/logger";

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
