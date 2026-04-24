import { describe, test, expect } from "bun:test";
import { softWrap, truncateArgs } from "../../../src/cli/stream/wrap";

describe("softWrap", () => {
  test("returns single line when under column width", () => {
    expect(softWrap("hello world", 80)).toEqual(["hello world"]);
  });

  test("wraps on whitespace at column boundary", () => {
    const out = softWrap("one two three four five", 10);
    expect(out).toEqual(["one two", "three four", "five"]);
  });

  test("breaks mid-word only when a single word exceeds width", () => {
    const out = softWrap("supercalifragilistic short", 10);
    expect(out[0].length).toBeLessThanOrEqual(10);
    expect(out.join("")).toContain("supercalifragilistic");
  });

  test("preserves explicit newlines", () => {
    expect(softWrap("a\nb", 80)).toEqual(["a", "b"]);
  });
});

describe("truncateArgs", () => {
  test("returns input unchanged when short enough", () => {
    expect(truncateArgs("abc", 200)).toBe("abc");
  });

  test("truncates with suffix indicating byte count when over limit", () => {
    const s = "x".repeat(250);
    const out = truncateArgs(s, 200);
    expect(out.length).toBeLessThan(s.length);
    expect(out).toMatch(/^x{1,200}…\s\(\+\d+\smore\)$/);
  });
});
