import { describe, test, expect } from "bun:test";
import { createServer } from "net";
import { pickFreePort } from "../../src/util/pick-free-port";

describe("pickFreePort", () => {
  test("returns a number in the valid TCP port range", async () => {
    const port = await pickFreePort();
    expect(typeof port).toBe("number");
    expect(Number.isInteger(port)).toBe(true);
    // Not pinning the ephemeral range rigidly — OSes vary.
    // Any usable non-privileged port is acceptable.
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });

  test("two calls return different ports", async () => {
    const a = await pickFreePort();
    const b = await pickFreePort();
    expect(a).not.toBe(b);
  });

  test("returned port is actually bindable", async () => {
    // The function under test IS the OS-port-binding logic. Verifying
    // the returned port can be bound is the actual contract — the prior
    // tests only check the *shape* of what's returned.
    //
    // TOCTOU note: pickFreePort releases the port before returning, so a
    // racing process could grab it. The source code documents this and
    // expects callers to retry. The test accepts this tiny window —
    // EADDRINUSE here is rare in practice and would be visible as a
    // flake, not a silent regression.
    const port = await pickFreePort();
    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(port, "127.0.0.1", () => {
        srv.close(() => resolve());
      });
    });
  });
});
