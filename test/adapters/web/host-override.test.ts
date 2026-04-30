import { describe, test, expect } from "bun:test";

// PRI-1436 regression gate (host-override leg): host-override.js was
// previously a module-level singleton with mutable `debugHost`/`debugPort`/
// `overrideEnabled`. Two concurrent WebAdapters calling `setEndpoint(host,
// port)` would stomp each other's host AND port — but the chrome-ws-lib
// isolation test only observes the port surface (`getActivePort`), leaving
// host-leakage uncovered. These tests pin the host surface directly:
// `createOverride()` must hand back independent state-bags whose host,
// port, override-enabled, base URL, and rewriteWsUrl outputs are mutually
// independent.
//
// The legacy module-level singleton API is left intact for upstream-compat
// (unmodified upstream code that destructures `CHROME_DEBUG_HOST` etc.
// keeps working). New Gauntlet callers go through `createOverride()`.

describe("host-override createOverride() isolation (PRI-1436)", () => {
  test("returns independent instances", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createOverride } = require("../../../src/adapters/web/lib/host-override");
    const a = createOverride();
    const b = createOverride();
    expect(a).not.toBe(b);
    expect(a.setDefaults).not.toBe(b.setDefaults);
    expect(a.getHost).not.toBe(b.getHost);
    expect(a.getPort).not.toBe(b.getPort);
  });

  test("setDefaults on one instance does not bleed into another", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createOverride } = require("../../../src/adapters/web/lib/host-override");
    const a = createOverride();
    const b = createOverride();
    a.setDefaults("alpha-host", 9301);
    b.setDefaults("beta-host", 9302);
    expect(a.getHost()).toBe("alpha-host");
    expect(a.getPort()).toBe(9301);
    expect(a.getBase()).toBe("http://alpha-host:9301");
    expect(a.isOverrideEnabled()).toBe(true);
    expect(b.getHost()).toBe("beta-host");
    expect(b.getPort()).toBe(9302);
    expect(b.getBase()).toBe("http://beta-host:9302");
    expect(b.isOverrideEnabled()).toBe(true);
    // Re-pointing a does not rewrite b.
    a.setDefaults("alpha-host-2", 9311);
    expect(a.getHost()).toBe("alpha-host-2");
    expect(b.getHost()).toBe("beta-host");
  });

  test("rewriteWsUrl uses each instance's own host/port", () => {
    // The original PRI-1436 bug class: under concurrent runs both adapters
    // saw whichever endpoint was last written to host-override's globals,
    // and rewriteWsUrl would resolve every CDP WebSocket URL through that
    // shared host. This pins the per-instance behavior.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createOverride } = require("../../../src/adapters/web/lib/host-override");
    const a = createOverride({ host: "a.example", port: 4001 });
    const b = createOverride({ host: "b.example", port: 4002 });
    const sourceUrl = "ws://127.0.0.1:9222/devtools/browser/abc";
    expect(a.rewriteWsUrl(sourceUrl)).toBe("ws://a.example:4001/devtools/browser/abc");
    expect(b.rewriteWsUrl(sourceUrl)).toBe("ws://b.example:4002/devtools/browser/abc");
    // Changing a's defaults must not change b's rewrite output.
    a.setDefaults("a2.example", 4011);
    expect(a.rewriteWsUrl(sourceUrl)).toBe("ws://a2.example:4011/devtools/browser/abc");
    expect(b.rewriteWsUrl(sourceUrl)).toBe("ws://b.example:4002/devtools/browser/abc");
  });

  test("instance with no options seeds from env defaults independently", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createOverride } = require("../../../src/adapters/web/lib/host-override");
    const a = createOverride();
    const b = createOverride();
    // Both seed from the same env (or fallback to defaults) but are
    // independent objects. Mutating a must not move b.
    const initialBHost = b.getHost();
    const initialBPort = b.getPort();
    a.setDefaults("dynamic-host", 5005);
    expect(b.getHost()).toBe(initialBHost);
    expect(b.getPort()).toBe(initialBPort);
  });

  test("rewriteWsUrl returns input unchanged when override is disabled", () => {
    // Sanity: a fresh instance with no env override and no setDefaults
    // call should leave URLs alone, matching the legacy behavior.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createOverride } = require("../../../src/adapters/web/lib/host-override");
    const a = createOverride();
    if (!a.isOverrideEnabled()) {
      const sourceUrl = "ws://127.0.0.1:9222/devtools/browser/abc";
      expect(a.rewriteWsUrl(sourceUrl)).toBe(sourceUrl);
    }
  });
});
