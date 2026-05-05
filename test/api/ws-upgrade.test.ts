import { describe, test, expect } from "bun:test";
import { decideUpgrade } from "../../src/api/ws-upgrade";
import { parseRunId, parseRunSetId } from "../../src/util/id";

describe("parseRunId", () => {
  test("accepts a well-formed runId", () => {
    expect(parseRunId("login-001_20260416T142301Z_k3xm")).toBe("login-001_20260416T142301Z_k3xm");
  });

  test("rejects empty string", () => {
    expect(parseRunId("")).toBeNull();
  });

  test("rejects undefined-shaped values", () => {
    // @ts-expect-error — exercising a missed-validation path
    expect(parseRunId(undefined)).toBeNull();
  });

  test("rejects parent-directory traversal", () => {
    expect(parseRunId("../../etc/passwd")).toBeNull();
    expect(parseRunId("login-001_20260416T142301Z_..xx")).toBeNull();
  });

  test("rejects unexpected characters", () => {
    expect(parseRunId("login-001_20260416T142301Z_k3xm; rm -rf /")).toBeNull();
    expect(parseRunId("login-001_20260416T142301Z_k3xm/extra")).toBeNull();
    expect(parseRunId("login-001 20260416T142301Z_k3xm")).toBeNull();
  });

  test("rejects malformed timestamps", () => {
    expect(parseRunId("login-001_20260416T_k3xm")).toBeNull();
    expect(parseRunId("login-001_2026-04-16T14:23:01Z_k3xm")).toBeNull();
  });
});

describe("parseRunSetId", () => {
  test("accepts well-formed run-set ids", () => {
    expect(parseRunSetId("single_20260416T142301Z_k3xm")).toBe("single_20260416T142301Z_k3xm");
    expect(parseRunSetId("batch_20260416T142301Z_k3xm")).toBe("batch_20260416T142301Z_k3xm");
  });

  test("rejects traversal sequences", () => {
    expect(parseRunSetId("../../etc/passwd")).toBeNull();
    expect(parseRunSetId("single_20260416T142301Z_..xx")).toBeNull();
  });

  test("rejects empty", () => {
    expect(parseRunSetId("")).toBeNull();
  });
});

describe("decideUpgrade", () => {
  function url(s: string): URL {
    return new URL(s, "http://localhost:4400");
  }
  function headers(entries: Record<string, string> = {}): Headers {
    return new Headers(entries);
  }

  test("rejects /api/ws with empty runId", () => {
    expect(decideUpgrade(url("/api/ws"), headers())).toBeNull();
    expect(decideUpgrade(url("/api/ws?run="), headers())).toBeNull();
  });

  test("rejects /api/ws with malformed runId", () => {
    expect(decideUpgrade(url("/api/ws?run=../etc/passwd"), headers())).toBeNull();
  });

  test("accepts /api/ws with a well-formed runId", () => {
    const result = decideUpgrade(url("/api/ws?run=login-001_20260416T142301Z_k3xm"), headers());
    expect(result).toEqual({ runId: "login-001_20260416T142301Z_k3xm" });
  });

  test("rejects /api/ws/run-sets/ with malformed id", () => {
    expect(decideUpgrade(url("/api/ws/run-sets/../etc"), headers())).toBeNull();
    expect(decideUpgrade(url("/api/ws/run-sets/"), headers())).toBeNull();
  });

  test("accepts /api/ws/run-sets/ with a well-formed id", () => {
    const result = decideUpgrade(url("/api/ws/run-sets/single_20260416T142301Z_k3xm"), headers());
    expect(result).toEqual({ runSetId: "single_20260416T142301Z_k3xm" });
  });

  test("returns null for unrelated paths (caller falls through to fetch)", () => {
    expect(decideUpgrade(url("/api/scenarios"), headers())).toBeNull();
    expect(decideUpgrade(url("/"), headers())).toBeNull();
  });

  describe("Origin allowlist (PRI-1483 §4)", () => {
    const goodUrl = url("/api/ws?run=login-001_20260416T142301Z_k3xm");

    test("accepts when allowlist is empty (allowlist disabled)", () => {
      expect(decideUpgrade(goodUrl, headers({ origin: "http://evil.example.com" }), { originAllowlist: [] })).not.toBeNull();
    });

    test("accepts when Origin matches an allowlist entry", () => {
      expect(decideUpgrade(goodUrl, headers({ origin: "http://localhost:4400" }), { originAllowlist: ["http://localhost:4400"] })).not.toBeNull();
    });

    test("rejects when allowlist is set and Origin does not match", () => {
      expect(decideUpgrade(goodUrl, headers({ origin: "http://evil.example.com" }), { originAllowlist: ["http://localhost:4400"] })).toBeNull();
    });

    test("rejects when allowlist is set and Origin is missing", () => {
      expect(decideUpgrade(goodUrl, headers({}), { originAllowlist: ["http://localhost:4400"] })).toBeNull();
    });
  });
});
