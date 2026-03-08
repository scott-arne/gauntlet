import { describe, test, expect } from "bun:test";
import { parseArgs } from "../../src/cli/args";

describe("parseArgs", () => {
  test("parses run command with required args", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "http://localhost:3000", "--out", "./evidence"]);
    expect(args.command).toBe("run");
    expect(args.scenarioPath).toBe("story.md");
    expect(args.target).toBe("http://localhost:3000");
    expect(args.outDir).toBe("./evidence");
  });

  test("defaults adapter to web", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "http://localhost:3000"]);
    expect(args.adapter).toBe("web");
  });

  test("parses adapter flag", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "cmd", "--adapter", "cli"]);
    expect(args.adapter).toBe("cli");
  });

  test("parses model flags", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "url", "--model", "agent=gpt-4o", "--model", "fanout=claude-sonnet-4-6"]);
    expect(args.models.agent).toBe("gpt-4o");
    expect(args.models.fanout).toBe("claude-sonnet-4-6");
  });

  test("throws on missing target", () => {
    expect(() => parseArgs(["bun", "index.ts", "run", "story.md"])).toThrow("--target");
  });

  test("throws on missing scenario path", () => {
    expect(() => parseArgs(["bun", "index.ts", "run"])).toThrow();
  });

  test("parses chrome flag", () => {
    const args = parseArgs(["bun", "index.ts", "run", "story.md", "--target", "url", "--chrome", "localhost:9222"]);
    expect(args.chrome).toBe("localhost:9222");
  });

  test("parses validate command", () => {
    const args = parseArgs(["bun", "index.ts", "validate", "story.md"]);
    expect(args.command).toBe("validate");
    expect(args.scenarioPath).toBe("story.md");
  });
});
