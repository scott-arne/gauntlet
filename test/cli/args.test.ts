import { describe, test, expect } from "bun:test";
import { parseArgs } from "../../src/cli/args";

describe("parseArgs", () => {
  test("parses run command with required args", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "http://localhost:3000", "--out", "./evidence"]);
    expect(args.command).toBe("run");
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.scenarioPath).toBe("story.md");
    expect(args.cli.target).toBe("http://localhost:3000");
    expect(args.outDir).toBe("./evidence");
  });

  test("defaults adapter to web", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "http://localhost:3000"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.adapter).toBe("web");
  });

  // Default outDir is derived from projectRoot + runId inside `run()`,
  // not baked in at parse time — so parseArgs must surface absence as
  // undefined. Bug fix: previously defaulted to "./evidence" (cwd),
  // which diverged from the serve path's `<project>/.gauntlet/results/<runId>`.
  test("leaves outDir undefined when --out is not provided", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "http://localhost:3000"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.outDir).toBeUndefined();
  });

  test("parses cli adapter flag", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "cmd", "--adapter", "cli"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.adapter).toBe("cli");
  });

  test("parses tui adapter flag", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "nano test.txt", "--adapter", "tui"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.adapter).toBe("tui");
  });

  test("rejects unknown --adapter value", () => {
    expect(() =>
      parseArgs(["bun", "index.ts", "run", "story.md", "--target", "url", "--adapter", "wat"]),
    ).toThrow(/must be one of/);
  });

  test("parses model flags", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "url", "--model", "agent=gpt-4o", "--model", "fanout=claude-sonnet-4-6"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.cli.models?.agent).toBe("gpt-4o");
    expect(args.cli.models?.fanout).toBe("claude-sonnet-4-6");
  });

  test("throws on missing target", () => {
    expect(() => parseArgs(["bun", "index.ts", "run", "story.md"])).toThrow("--target");
  });

  test("throws on missing scenario path", () => {
    expect(() => parseArgs(["bun", "index.ts", "run"])).toThrow();
  });

  test("parses chrome flag", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "url", "--chrome", "localhost:9222"]);
    if (args.command !== "run") throw new Error("unreachable");
    expect(args.cli.chrome).toBe("localhost:9222");
  });

  test("parses validate command", () => {
    const args = parseArgs(["bun", "index.ts", "validate", "story.md"]);
    expect(args.command).toBe("validate");
    expect(args.scenarioPath).toBe("story.md");
  });

  test("parses fanout command with scenario path", () => {
    const args = parseArgs(["bun", "index.ts", "fanout", "story.md", "--out", "./cards"]);
    expect(args.command).toBe("fanout");
    if (args.command !== "fanout") throw new Error("unreachable");
    expect(args.scenarioPath).toBe("story.md");
    expect(args.resultDir).toBeUndefined();
    expect(args.outDir).toBe("./cards");
  });

  test("parses fanout --from-result flag", () => {
    const args = parseArgs(["bun", "index.ts", "fanout", "--from-result", "./evidence/story-001", "--out", "./cards"]);
    expect(args.command).toBe("fanout");
    if (args.command !== "fanout") throw new Error("unreachable");
    expect(args.resultDir).toBe("./evidence/story-001");
    expect(args.scenarioPath).toBeUndefined();
    expect(args.outDir).toBe("./cards");
  });

  test("fanout throws when neither scenario path nor --from-result provided", () => {
    expect(() => parseArgs(["bun", "index.ts", "fanout"])).toThrow();
  });
});
