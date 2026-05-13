import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseArgs } from "../../src/cli/args";
import { ask } from "../../src/cli/ask";

describe("parseArgs ask", () => {
  test("parses positional runId", () => {
    const r = parseArgs(["bun", "gauntlet", "ask", "login-001_20260101T000000Z_abcd"]);
    expect(r.command).toBe("ask");
    expect((r as { runId: string }).runId).toBe("login-001_20260101T000000Z_abcd");
  });

  test("parses --turn", () => {
    const r = parseArgs(["bun", "gauntlet", "ask", "rid", "--turn", "5"]);
    expect((r as { upToTurn?: number }).upToTurn).toBe(5);
  });

  test("parses --model as a bare model id", () => {
    const r = parseArgs(["bun", "gauntlet", "ask", "rid", "--model", "claude-opus-4-7"]);
    expect((r as { modelOverride?: string }).modelOverride).toBe("claude-opus-4-7");
  });

  test("rejects unknown flags", () => {
    expect(() => parseArgs(["bun", "gauntlet", "ask", "rid", "--bogus", "x"])).toThrow(/Unknown flag/);
  });

  test("requires a runId positional", () => {
    expect(() => parseArgs(["bun", "gauntlet", "ask"])).toThrow(/runId|Usage/);
  });
});

describe("ask error paths", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    while (cleanups.length) {
      const d = cleanups.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  test("returns 1 and logs when the run directory does not exist", async () => {
    const projRoot = mkdtempSync(join(tmpdir(), "gauntlet-ask-"));
    cleanups.push(projRoot);
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...msg: unknown[]) => { errors.push(msg.map((m) => String(m)).join(" ")); };
    try {
      const code = await ask(
        { command: "ask", runId: "nonexistent_run", cli: {} },
        { projectRoot: projRoot } as never,
      );
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes("Run not found"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  test("returns 1 and logs when the run directory exists but run.jsonl is missing", async () => {
    const projRoot = mkdtempSync(join(tmpdir(), "gauntlet-ask-"));
    cleanups.push(projRoot);
    mkdirSync(join(projRoot, ".gauntlet", "results", "empty_run"), { recursive: true });
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...msg: unknown[]) => { errors.push(msg.map((m) => String(m)).join(" ")); };
    try {
      const code = await ask(
        { command: "ask", runId: "empty_run", cli: {} },
        { projectRoot: projRoot } as never,
      );
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes("no run.jsonl"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });
});
