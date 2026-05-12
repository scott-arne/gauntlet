import { describe, test, expect } from "bun:test";
import { parseDuration } from "../../src/util/parse-duration";

describe("parseDuration", () => {
  test("accepts plain integer as seconds", () => {
    expect(parseDuration("300")).toBe(300_000);
    expect(parseDuration("1")).toBe(1_000);
  });

  test("accepts ms suffix", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  test("accepts s suffix", () => {
    expect(parseDuration("90s")).toBe(90_000);
  });

  test("accepts m suffix", () => {
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1m")).toBe(60_000);
  });

  test("accepts h suffix", () => {
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  test("rejects negative numbers", () => {
    expect(() => parseDuration("-1s")).toThrow(/invalid duration/i);
  });

  test("rejects zero", () => {
    expect(() => parseDuration("0")).toThrow(/invalid duration/i);
    expect(() => parseDuration("0s")).toThrow(/invalid duration/i);
  });

  test("rejects unknown suffix", () => {
    expect(() => parseDuration("5x")).toThrow(/invalid duration/i);
  });

  test("rejects empty string", () => {
    expect(() => parseDuration("")).toThrow(/invalid duration/i);
  });

  test("rejects whitespace-only", () => {
    expect(() => parseDuration("   ")).toThrow(/invalid duration/i);
  });

  test("rejects non-numeric prefix", () => {
    expect(() => parseDuration("abc")).toThrow(/invalid duration/i);
    expect(() => parseDuration("5m extra")).toThrow(/invalid duration/i);
  });

  test("rejects fractional values", () => {
    expect(() => parseDuration("1.5m")).toThrow(/invalid duration/i);
  });

  test("error message includes the offending input", () => {
    try {
      parseDuration("xyz");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("xyz");
    }
  });
});
