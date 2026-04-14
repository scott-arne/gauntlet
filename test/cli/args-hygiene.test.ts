import { describe, test, expect } from "bun:test";
import { parseArgs } from "../../src/cli/args";

describe("CLI flag hygiene", () => {
  test("parseServeArgs rejects unknown flag", () => {
    expect(() => parseArgs(["bun", "gauntlet", "serve", "--bogus", "x"]))
      .toThrow(/unknown flag.*--bogus/i);
  });

  test("parseServeArgs accepts --chrome, --data-dir, --port, --model, --target", () => {
    const args = parseArgs([
      "bun", "gauntlet", "serve",
      "--port", "4400",
      "--data-dir", "/tmp/x",
      "--chrome", "localhost:9222",
      "--model", "agent=claude-sonnet-4-6",
      "--target", "http://localhost:3000",
    ]);
    expect(args.command).toBe("serve");
    // Specific field assertions come in Task 4 after AppConfig shape is set.
  });

  test("parseRunArgs rejects unknown flag", () => {
    expect(() => parseArgs(["bun", "gauntlet", "run", "foo.md", "--target", "http://x", "--nope", "y"]))
      .toThrow(/unknown flag.*--nope/i);
  });

  test("parseRunArgs accepts --target, --model, --chrome, --adapter, --out", () => {
    const args = parseArgs([
      "bun", "gauntlet", "run", "foo.md",
      "--target", "http://localhost:3000",
      "--model", "agent=claude-sonnet-4-6",
      "--chrome", "localhost:9222",
      "--adapter", "web",
      "--out", "/tmp/out",
    ]);
    expect(args.command).toBe("run");
  });

  test("parseFanoutArgs rejects unknown flag", () => {
    expect(() => parseArgs(["bun", "gauntlet", "fanout", "foo.md", "--bogus", "y"]))
      .toThrow(/unknown flag.*--bogus/i);
  });

  test("parseValidateArgs rejects unknown flag", () => {
    expect(() => parseArgs(["bun", "gauntlet", "validate", "foo.md", "--bogus", "y"]))
      .toThrow(/unknown flag.*--bogus/i);
  });

  test("error mentions valid flags for command", () => {
    try {
      parseArgs(["bun", "gauntlet", "serve", "--bogus", "x"]);
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/--port/);
      expect(msg).toMatch(/--data-dir/);
      expect(msg).toMatch(/--chrome/);
    }
  });

  test("bareword flag followed by another flag does not eat it", () => {
    const args = parseArgs([
      "bun", "gauntlet", "config",
      "--json",
      "--data-dir", "/tmp/x",
    ]);
    expect(args.command).toBe("config");
    expect((args as any).json).toBe(true);
    expect((args as any).cli.dataDir).toBe("/tmp/x");
  });

  test("bareword --json alone parses correctly", () => {
    const args = parseArgs(["bun", "gauntlet", "config", "--json"]);
    expect((args as any).json).toBe(true);
  });

  test("--json true still works (explicit value form)", () => {
    const args = parseArgs(["bun", "gauntlet", "config", "--json", "true"]);
    expect((args as any).json).toBe(true);
  });
});
