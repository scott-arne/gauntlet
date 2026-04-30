import { describe, test, expect } from "bun:test";
import { makeRunId, makeRunSetId, sanitizeProfileSegment } from "../../src/util/id";

describe("makeRunId", () => {
  test("returns a non-empty string", () => {
    const id = makeRunId("card-001");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("composes <cardId>_<timestamp>_<nonce> with three underscore-separated parts", () => {
    const id = makeRunId("login-001");
    const parts = id.split("_");
    expect(parts).toHaveLength(3);
  });

  test("preserves the cardId verbatim as the leading segment", () => {
    expect(makeRunId("login-001").split("_")[0]).toBe("login-001");
    expect(makeRunId("foo-bar-baz").split("_")[0]).toBe("foo-bar-baz");
  });

  test("middle segment is an ISO 8601 basic-format UTC timestamp at second precision", () => {
    const ts = makeRunId("c").split("_")[1];
    // YYYYMMDDTHHMMSSZ — e.g. 20260416T142301Z
    expect(ts).toMatch(/^\d{8}T\d{6}Z$/);
  });

  test("trailing nonce is 4 base36 characters", () => {
    const nonce = makeRunId("c").split("_")[2];
    expect(nonce).toMatch(/^[a-z0-9]{4}$/);
  });

  test("two calls in quick succession produce different ids", () => {
    // Same-second collisions are resolved by the random nonce.
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(makeRunId("c"));
    expect(ids.size).toBeGreaterThan(1);
  });

  test("composes safely into a Chrome profile name (no collisions with /^[a-zA-Z0-9_-]+$/)", () => {
    // chrome-ws-lib's setProfileName enforces /^[a-zA-Z0-9_-]+$/. The runId
    // is embedded into `gauntlet-run-<runId>` directly, so it must remain
    // within that character set on its own.
    for (let i = 0; i < 20; i++) {
      expect(makeRunId("card-001")).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});

describe("makeRunSetId", () => {
  test("kind=single produces single_<ts>_<nonce>", () => {
    const id = makeRunSetId("single");
    expect(id).toMatch(/^single_\d{8}T\d{6}Z_[a-z0-9]{4}$/);
  });

  test("kind=batch produces batch_<ts>_<nonce>", () => {
    const id = makeRunSetId("batch");
    expect(id).toMatch(/^batch_\d{8}T\d{6}Z_[a-z0-9]{4}$/);
  });

  test("two consecutive ids differ", () => {
    const a = makeRunSetId("single");
    const b = makeRunSetId("single");
    expect(a).not.toBe(b);
  });
});

describe("sanitizeProfileSegment", () => {
  test("passes through already-safe segments", () => {
    expect(sanitizeProfileSegment("alice")).toBe("alice");
    expect(sanitizeProfileSegment("card-001_v2")).toBe("card-001_v2");
  });

  test("replaces unsafe characters with hyphens", () => {
    expect(sanitizeProfileSegment("foo/bar")).toBe("foo-bar");
    expect(sanitizeProfileSegment("foo.bar")).toBe("foo-bar");
    expect(sanitizeProfileSegment("a b c")).toBe("a-b-c");
    expect(sanitizeProfileSegment("weird$name!")).toBe("weird-name-");
  });

  test("produces output matching the chrome-ws-lib regex", () => {
    const samples = ["alice", "card-001", "weird$name!", "foo/bar", "tab\ttab"];
    for (const s of samples) {
      expect(sanitizeProfileSegment(s)).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});
