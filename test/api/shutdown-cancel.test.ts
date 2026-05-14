import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ShutdownState, drainShutdown } from "../../src/api/shutdown";
import { RunBroadcaster } from "../../src/api/ws";
import { RunSetBroadcaster } from "../../src/api/run-set-broadcaster";

// PRI-1507 — full shutdown drain story tests. Distinct from
// shutdown.test.ts (which covers the basic mechanics from PRI-1477A);
// this file owns the four paths added by PRI-1507:
//   Case 1: clean drain (no abort needed)
//   Case 2: abort observed → all runs exit before patience window
//   Case 3: stub fallback → patience window expires
//   Case 4: zero in-flight at signal time

interface FakeRun {
  id: string;
  cardId: string;
  startedAt: number;
}

class StubRegistry {
  runs = new Map<string, FakeRun>();
  abortAllCalled = 0;
  /** When set, abort() also removes the run from the registry to
   * simulate an agent that cooperatively shuts down on observing
   * the signal (Case 2). */
  cooperativeAbort = false;

  constructor(initial: FakeRun[] = []) {
    for (const r of initial) this.runs.set(r.id, r);
  }

  list(): FakeRun[] {
    return Array.from(this.runs.values());
  }

  abortAll(_reason: string): number {
    this.abortAllCalled++;
    const count = this.runs.size;
    if (this.cooperativeAbort) {
      this.runs.clear();
    }
    return count;
  }

  unregister(runId: string): void {
    this.runs.delete(runId);
  }
}

describe("drainShutdown — PRI-1507 paths", () => {
  test("Case 1 — clean drain: no abort, no stubs, drainedCleanly=true", async () => {
    const state = new ShutdownState();
    const registry = new StubRegistry(); // empty
    const resultsRoot = mkdtempSync(join(tmpdir(), "shutdown-case1-"));

    const result = await drainShutdown({
      signal: "SIGTERM",
      state,
      broadcaster: new RunBroadcaster(),
      setBroadcaster: new RunSetBroadcaster(),
      registry,
      resultsRoot,
      graceMs: 200,
      postAbortMs: 100,
      pollMs: 20,
      log: () => {},
    });

    expect(result.drainedCleanly).toBe(true);
    expect(result.aborted).toBe(0);
    expect(result.stubbed).toBe(0);
    expect(registry.abortAllCalled).toBe(0);
  });

  test("Case 2 — abort observed: agents drain during patience window, no stubs", async () => {
    const state = new ShutdownState();
    const registry = new StubRegistry([
      { id: "r-a", cardId: "card-a", startedAt: Date.now() - 5000 },
      { id: "r-b", cardId: "card-b", startedAt: Date.now() - 5000 },
    ]);
    registry.cooperativeAbort = true; // agents exit cleanly on abort
    const resultsRoot = mkdtempSync(join(tmpdir(), "shutdown-case2-"));

    // Pre-write result.json for each run, mimicking the orchestrator's
    // success path having completed before unregister.
    for (const r of registry.list()) {
      const runDir = join(resultsRoot, r.id);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "result.json"), JSON.stringify({ status: "errored", real: true }));
    }

    const result = await drainShutdown({
      signal: "SIGTERM",
      state,
      broadcaster: new RunBroadcaster(),
      setBroadcaster: new RunSetBroadcaster(),
      registry,
      resultsRoot,
      graceMs: 100,
      postAbortMs: 500,
      pollMs: 20,
      log: () => {},
    });

    expect(result.drainedCleanly).toBe(false); // grace timed out
    expect(result.aborted).toBe(2);
    expect(result.remaining).toBe(0); // patience window cleaned them up
    expect(result.stubbed).toBe(0); // no stubs needed
    expect(registry.abortAllCalled).toBe(1);

    // Real result.json files preserved
    const realResult = JSON.parse(readFileSync(join(resultsRoot, "r-a", "result.json"), "utf-8"));
    expect(realResult.real).toBe(true);
  });

  test("Case 3 — stub fallback: patience window expires; stubs written for missing files", async () => {
    const state = new ShutdownState();
    const startedAt = Date.now() - 30_000;
    const registry = new StubRegistry([
      { id: "r-x", cardId: "card-x", startedAt },
      { id: "r-y", cardId: "card-y", startedAt },
    ]);
    // cooperativeAbort=false: agents stuck mid-tool-call; never exit
    const resultsRoot = mkdtempSync(join(tmpdir(), "shutdown-case3-"));

    // Pre-write a real result.json ONLY for r-y, simulating the
    // patience-window-race winner (orchestrator's writeResultFiles fired
    // just before the patience window closed). The stub writer should
    // NOT overwrite it.
    const yDir = join(resultsRoot, "r-y");
    mkdirSync(yDir, { recursive: true });
    writeFileSync(join(yDir, "result.json"), JSON.stringify({ status: "pass", real: true, runId: "r-y" }));

    const result = await drainShutdown({
      signal: "SIGTERM",
      state,
      broadcaster: new RunBroadcaster(),
      setBroadcaster: new RunSetBroadcaster(),
      registry,
      resultsRoot,
      graceMs: 100,
      postAbortMs: 100,
      pollMs: 20,
      log: () => {},
    });

    expect(result.drainedCleanly).toBe(false);
    expect(result.aborted).toBe(2);
    expect(result.stubbed).toBe(1); // only r-x got stubbed

    // r-x got a stub
    const xStub = JSON.parse(readFileSync(join(resultsRoot, "r-x", "result.json"), "utf-8"));
    expect(xStub.status).toBe("errored");
    expect(xStub.error.type).toBe("shutdown_interrupted");
    expect(xStub.duration_ms).toBeGreaterThan(0); // derived from startedAt

    // r-y's pre-existing result.json untouched
    const yResult = JSON.parse(readFileSync(join(resultsRoot, "r-y", "result.json"), "utf-8"));
    expect(yResult.real).toBe(true);
    expect(yResult.status).toBe("pass");
  });

  test("Case 4 — zero in-flight: drainedCleanly=true with no machinery fired", async () => {
    const state = new ShutdownState();
    const registry = new StubRegistry(); // empty from the start
    const resultsRoot = mkdtempSync(join(tmpdir(), "shutdown-case4-"));

    const cancelAllCalls = { count: 0 };
    const result = await drainShutdown({
      signal: "SIGTERM",
      state,
      broadcaster: new RunBroadcaster(),
      setBroadcaster: new RunSetBroadcaster(),
      registry,
      cancelTokens: { cancelAll: () => { cancelAllCalls.count++; return 0; } },
      resultsRoot,
      graceMs: 200,
      postAbortMs: 100,
      pollMs: 20,
      log: () => {},
    });

    expect(result.drainedCleanly).toBe(true);
    expect(result.aborted).toBe(0);
    expect(result.stubbed).toBe(0);
    expect(registry.abortAllCalled).toBe(0);
    expect(cancelAllCalls.count).toBe(0); // never called on the clean path
  });

  test("Case 5 — multi-pass: cancelAll fires BEFORE abortAll to gate run-set loops", async () => {
    const state = new ShutdownState();
    const registry = new StubRegistry([
      { id: "ms-a-1", cardId: "card-a", startedAt: Date.now() - 1000 },
    ]);
    registry.cooperativeAbort = true;
    const resultsRoot = mkdtempSync(join(tmpdir(), "shutdown-case5-"));
    mkdirSync(join(resultsRoot, "ms-a-1"), { recursive: true });
    writeFileSync(
      join(resultsRoot, "ms-a-1", "result.json"),
      JSON.stringify({ status: "errored", runId: "ms-a-1" }),
    );

    const callOrder: string[] = [];
    const result = await drainShutdown({
      signal: "SIGTERM",
      state,
      broadcaster: new RunBroadcaster(),
      setBroadcaster: new RunSetBroadcaster(),
      registry: {
        list: () => { return registry.list(); },
        abortAll: (r) => { callOrder.push("abortAll"); return registry.abortAll(r); },
      },
      cancelTokens: { cancelAll: () => { callOrder.push("cancelAll"); return 1; } },
      resultsRoot,
      graceMs: 100,
      postAbortMs: 200,
      pollMs: 20,
      log: () => {},
    });

    expect(result.drainedCleanly).toBe(false);
    expect(callOrder).toEqual(["cancelAll", "abortAll"]); // cancelAll first
  });
});
