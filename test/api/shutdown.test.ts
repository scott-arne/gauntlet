import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { ShutdownState, drainShutdown } from "../../src/api/shutdown";
import { RunBroadcaster } from "../../src/api/ws";
import { RunSetBroadcaster } from "../../src/api/run-set-broadcaster";

type Closeable = {
  readyState: number;
  send(_: string): void;
  close(code?: number, reason?: string): void;
};

function fakeWs(): Closeable & { closeArgs: Array<[number?, string?]> } {
  const ws = {
    readyState: 1,
    send() {},
    closeArgs: [] as Array<[number?, string?]>,
    close(code?: number, reason?: string) {
      ws.closeArgs.push([code, reason]);
      ws.readyState = 3;
    },
  };
  return ws;
}

describe("ShutdownState", () => {
  test("starts not-draining; mark() flips it", () => {
    const s = new ShutdownState();
    expect(s.isDraining()).toBe(false);
    s.mark("SIGTERM");
    expect(s.isDraining()).toBe(true);
    expect(s.signal).toBe("SIGTERM");
  });

  test("mark() is idempotent — first signal wins", () => {
    const s = new ShutdownState();
    s.mark("SIGTERM");
    s.mark("SIGINT");
    expect(s.signal).toBe("SIGTERM");
  });
});

describe("RunBroadcaster.closeAll", () => {
  test("closes every connected client with code+reason and clears the registry", () => {
    const b = new RunBroadcaster();
    const a = fakeWs();
    const c = fakeWs();
    b.addClient("run-1", a);
    b.addClient("run-2", c);

    b.closeAll(1001, "shutting down");

    expect(a.closeArgs).toEqual([[1001, "shutting down"]]);
    expect(c.closeArgs).toEqual([[1001, "shutting down"]]);
  });

  test("tolerates clients whose .close throws (one bad client doesn't block the rest)", () => {
    const b = new RunBroadcaster();
    const bad = fakeWs();
    bad.close = () => { throw new Error("boom"); };
    const good = fakeWs();
    b.addClient("run-1", bad);
    b.addClient("run-2", good);

    expect(() => b.closeAll(1001, "shutting down")).not.toThrow();
    expect(good.closeArgs).toEqual([[1001, "shutting down"]]);
  });
});

describe("RunSetBroadcaster.closeAll", () => {
  test("closes every connected client with code+reason", () => {
    const b = new RunSetBroadcaster();
    const a = fakeWs();
    const c = fakeWs();
    b.addClient("rset-1", a);
    b.addClient("rset-2", c);

    b.closeAll(1001, "shutting down");

    expect(a.closeArgs).toEqual([[1001, "shutting down"]]);
    expect(c.closeArgs).toEqual([[1001, "shutting down"]]);
  });
});

describe("drainShutdown", () => {
  test("sets draining flag, closes both broadcasters, returns immediately if registry is empty", async () => {
    const state = new ShutdownState();
    const broadcaster = new RunBroadcaster();
    const setBroadcaster = new RunSetBroadcaster();
    const wsRun = fakeWs();
    const wsSet = fakeWs();
    broadcaster.addClient("run-1", wsRun);
    setBroadcaster.addClient("rset-1", wsSet);

    const log: string[] = [];
    const before = Date.now();
    const result = await drainShutdown({
      signal: "SIGTERM",
      state,
      broadcaster,
      setBroadcaster,
      registry: { list: () => [] },
      graceMs: 5000,
      pollMs: 25,
      log: (m) => log.push(m),
    });
    const elapsed = Date.now() - before;

    expect(state.isDraining()).toBe(true);
    expect(wsRun.closeArgs).toEqual([[1001, "shutting down"]]);
    expect(wsSet.closeArgs).toEqual([[1001, "shutting down"]]);
    expect(result.drainedCleanly).toBe(true);
    expect(elapsed).toBeLessThan(500); // empty registry → fast return
    expect(log[0]).toContain("SIGTERM");
  });

  test("polls registry until empty when runs are in flight, then returns drainedCleanly=true", async () => {
    const state = new ShutdownState();
    const remaining = [{ id: "run-1" } as any, { id: "run-2" } as any];
    let calls = 0;
    const registry = {
      list: () => {
        calls++;
        if (calls >= 3) return [];
        return remaining;
      },
    };

    const result = await drainShutdown({
      signal: "SIGINT",
      state,
      broadcaster: new RunBroadcaster(),
      setBroadcaster: new RunSetBroadcaster(),
      registry,
      graceMs: 5000,
      pollMs: 25,
      log: () => {},
    });

    expect(result.drainedCleanly).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("times out after graceMs and returns drainedCleanly=false when runs persist", async () => {
    const state = new ShutdownState();
    const registry = { list: () => [{ id: "stuck-run" } as any] };

    const before = Date.now();
    const result = await drainShutdown({
      signal: "SIGTERM",
      state,
      broadcaster: new RunBroadcaster(),
      setBroadcaster: new RunSetBroadcaster(),
      registry,
      graceMs: 200,
      pollMs: 25,
      log: () => {},
    });
    const elapsed = Date.now() - before;

    expect(result.drainedCleanly).toBe(false);
    expect(result.remaining).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("createApp drain middleware", () => {
  // We import lazily to avoid pulling all of createApp's deps if some
  // module in that graph fails to load in this isolated test context.
  test("returns 503 with shutting_down envelope when state.draining=true", async () => {
    const { createApp } = await import("../../src/api/server");
    const state = new ShutdownState();
    state.mark("SIGTERM");

    const config = {
      projectRoot: "/tmp/does-not-matter-for-this-test",
      port: 4400,
      defaultChrome: { host: "127.0.0.1", port: 9222 },
      defaultBudgetMs: 300_000,
      defaultMaxStuckRetries: 5,
      defaultViewport: { width: 1440, height: 900 },
      saveScreencast: false,
      shutdownGraceMs: 10000,
      models: { agent: "claude-sonnet-4-6", fanout: undefined, available: [] },
      sources: { defaultChrome: "default" },
      apiKeys: { anthropic: false, openai: false },
    } as any;

    const app = createApp(config, undefined, undefined, undefined, undefined, undefined, state);

    const res = await app.request("/api/run/anything", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "http://localhost:3000" }),
    });

    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("shutting_down");
  });

  test("does NOT block /api/runs/active or other GETs while draining (clients can still poll)", async () => {
    const { createApp } = await import("../../src/api/server");
    const { ActiveRunRegistry } = await import("../../src/api/active-runs");
    const state = new ShutdownState();
    state.mark("SIGTERM");

    const config = {
      projectRoot: "/tmp/does-not-matter-for-this-test",
      port: 4400,
      defaultChrome: { host: "127.0.0.1", port: 9222 },
      defaultBudgetMs: 300_000,
      defaultMaxStuckRetries: 5,
      defaultViewport: { width: 1440, height: 900 },
      saveScreencast: false,
      shutdownGraceMs: 10000,
      models: { agent: "claude-sonnet-4-6", fanout: undefined, available: [] },
      sources: { defaultChrome: "default" },
      apiKeys: { anthropic: false, openai: false },
    } as any;

    const registry = new ActiveRunRegistry();
    const app = createApp(config, undefined, undefined, registry, undefined, undefined, state);

    const res = await app.request("/api/runs/active");
    expect(res.status).toBe(200);
  });
});
