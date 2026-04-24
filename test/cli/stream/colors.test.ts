import { describe, test, expect } from "bun:test";
import { makePaint } from "../../../src/cli/stream/colors";

describe("makePaint", () => {
  test("wraps text in ANSI when enabled", () => {
    const p = makePaint(true);
    const out = p.cyan("hi");
    expect(out.startsWith("\x1b[")).toBe(true);
    expect(out.endsWith("\x1b[0m")).toBe(true);
    expect(out).toContain("hi");
  });

  test("returns raw text when disabled", () => {
    const p = makePaint(false);
    expect(p.cyan("hi")).toBe("hi");
    expect(p.bold("x")).toBe("x");
  });

  test("dim + green are distinct codes", () => {
    const p = makePaint(true);
    expect(p.dim("x")).not.toBe(p.green("x"));
  });

  test("supports chained formatting via bold + color", () => {
    const p = makePaint(true);
    const out = p.bold(p.red("err"));
    expect(out).toContain("err");
    expect(out.startsWith("\x1b[")).toBe(true);
  });
});
