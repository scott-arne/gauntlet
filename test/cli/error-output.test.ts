import { describe, test, expect } from "bun:test";
import { formatCliError, isVerboseRequest } from "../../src/cli/error-output";

describe("formatCliError", () => {
  test("emits a single-line JSON envelope for a plain Error", () => {
    const out = formatCliError(new Error("boom"), { verbose: false });
    expect(out.endsWith("\n")).toBe(true);
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual({ error: { message: "boom" } });
  });

  test("includes errno code when error carries one (e.g. ENOENT)", () => {
    const err = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const out = formatCliError(err, { verbose: false });
    const parsed = JSON.parse(out.trimEnd());
    expect(parsed).toEqual({ error: { message: "ENOENT: no such file", code: "ENOENT" } });
  });

  test("appends stack trace on a separate line when verbose=true", () => {
    const err = new Error("boom");
    const out = formatCliError(err, { verbose: true });
    const lines = out.trimEnd().split("\n");
    // First line is the JSON envelope; remainder is the stack trace.
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(lines.slice(1).join("\n")).toContain("Error: boom");
  });

  test("never includes stack trace when verbose=false", () => {
    const err = new Error("boom");
    const out = formatCliError(err, { verbose: false });
    expect(out).not.toContain(err.stack ?? "__sentinel__");
    expect(out.trimEnd().split("\n")).toHaveLength(1);
  });

  test("wraps non-Error thrown values safely", () => {
    const out = formatCliError("string thrown", { verbose: false });
    const parsed = JSON.parse(out.trimEnd());
    expect(parsed).toEqual({ error: { message: "string thrown" } });
  });

  test("output is always valid JSON on the first line, regardless of message contents", () => {
    const tricky = new Error('contains "quotes" and \nnewlines and \\backslashes');
    const out = formatCliError(tricky, { verbose: false });
    const firstLine = out.trimEnd().split("\n")[0];
    const parsed = JSON.parse(firstLine);
    expect(parsed.error.message).toBe('contains "quotes" and \nnewlines and \\backslashes');
  });
});

describe("isVerboseRequest", () => {
  test("returns true when GAUNTLET_DEBUG=1", () => {
    expect(isVerboseRequest({ GAUNTLET_DEBUG: "1" }, [])).toBe(true);
  });

  test("returns true when --verbose appears in argv", () => {
    expect(isVerboseRequest({}, ["bun", "src/index.ts", "run", "story.md", "--verbose"])).toBe(true);
  });

  test("returns false when neither signal is present", () => {
    expect(isVerboseRequest({}, ["bun", "src/index.ts", "run", "story.md"])).toBe(false);
  });

  test("ignores GAUNTLET_DEBUG values other than '1' (avoid surprising behavior)", () => {
    expect(isVerboseRequest({ GAUNTLET_DEBUG: "0" }, [])).toBe(false);
    expect(isVerboseRequest({ GAUNTLET_DEBUG: "" }, [])).toBe(false);
    expect(isVerboseRequest({ GAUNTLET_DEBUG: "true" }, [])).toBe(false);
  });
});
