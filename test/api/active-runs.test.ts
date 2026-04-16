import { describe, test, expect } from "bun:test";
import { ActiveRunRegistry } from "../../src/api/active-runs";

describe("ActiveRunRegistry", () => {
  // Per-run shape: `id` is the runId (the primary key), `cardId` is
  // payload metadata. Tests use synthetic ids that satisfy both fields
  // independently — the registry doesn't parse runId structure.
  const info = (runId: string, startedAt: number, cardId = "card-x") => ({
    id: runId,
    cardId,
    title: `Title ${runId}`,
    target: "http://localhost:3000",
    model: "claude-sonnet-4-6",
    startedAt,
  });

  test("register + list + has", () => {
    const r = new ActiveRunRegistry();
    expect(r.list()).toEqual([]);
    expect(r.has("a")).toBe(false);

    r.register(info("a", 100));
    expect(r.has("a")).toBe(true);
    expect(r.list()).toEqual([info("a", 100)]);
  });

  test("list sorted by startedAt desc", () => {
    const r = new ActiveRunRegistry();
    r.register(info("a", 100));
    r.register(info("b", 300));
    r.register(info("c", 200));
    expect(r.list().map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  test("register with the same key replaces (last-wins) — distinct runIds normally avoid this", () => {
    // With a real runId containing a timestamp + nonce, collisions are
    // vanishingly rare. The replacement behavior is preserved as a
    // defensive last-wins for edge cases (manual id reuse in tests).
    const r = new ActiveRunRegistry();
    r.register(info("a", 100));
    r.recordProgress("a", "old");
    r.register(info("a", 200));
    const snap = r.getSnapshot("a");
    expect(snap?.info.startedAt).toBe(200);
    expect(snap?.progressLog).toEqual([]);
  });

  test("unregister removes the entry", () => {
    const r = new ActiveRunRegistry();
    r.register(info("a", 100));
    r.unregister("a");
    expect(r.has("a")).toBe(false);
    expect(r.getSnapshot("a")).toBeNull();
  });

  test("unregister with matching startedAt deletes entry", () => {
    const r = new ActiveRunRegistry();
    r.register(info("a", 100));
    r.unregister("a", 100);
    expect(r.has("a")).toBe(false);
  });

  test("unregister with mismatched startedAt does not delete entry", () => {
    const r = new ActiveRunRegistry();
    r.register(info("a", 100));
    r.unregister("a", 999);
    expect(r.has("a")).toBe(true);
  });

  test("unregister without startedAt still deletes (back-compat)", () => {
    const r = new ActiveRunRegistry();
    r.register(info("a", 100));
    r.unregister("a");
    expect(r.has("a")).toBe(false);
  });

  test("re-register + first run's unregister does not clobber second run", () => {
    const r = new ActiveRunRegistry();
    r.register(info("a", 100));
    // Second run reuses the key before first run's finally executes
    r.register(info("a", 200));
    // First run's finally fires
    r.unregister("a", 100);
    // Second run should still be tracked
    expect(r.has("a")).toBe(true);
    expect(r.getSnapshot("a")?.info.startedAt).toBe(200);
  });

  test("recordFrame stores latest frame", () => {
    const r = new ActiveRunRegistry();
    r.register(info("a", 100));
    r.recordFrame("a", { data: "AAA", width: 10, height: 20 });
    r.recordFrame("a", { data: "BBB", width: 30, height: 40 });
    expect(r.getSnapshot("a")?.lastFrame).toEqual({ data: "BBB", width: 30, height: 40 });
  });

  test("recordProgress appends, capped at 200", () => {
    const r = new ActiveRunRegistry();
    r.register(info("a", 100));
    for (let i = 0; i < 250; i++) r.recordProgress("a", `msg-${i}`);
    const log = r.getSnapshot("a")!.progressLog;
    expect(log.length).toBe(200);
    expect(log[0]).toBe("msg-50");
    expect(log[199]).toBe("msg-249");
  });

  test("recordFrame/recordProgress on unknown id no-ops", () => {
    const r = new ActiveRunRegistry();
    expect(() => r.recordFrame("nope", { data: "x", width: 1, height: 1 })).not.toThrow();
    expect(() => r.recordProgress("nope", "x")).not.toThrow();
    expect(r.has("nope")).toBe(false);
  });

  test("getSnapshot returns null for unknown id", () => {
    const r = new ActiveRunRegistry();
    expect(r.getSnapshot("nope")).toBeNull();
  });

  test("entries carry both runId (id) and cardId so callers can group by card", () => {
    // Two distinct runs of the same card produce distinct registry
    // entries; each retains the cardId for filtering/grouping.
    const r = new ActiveRunRegistry();
    r.register(info("login-001_20260416T142301Z_k3xm", 100, "login-001"));
    r.register(info("login-001_20260416T142302Z_qq8a", 200, "login-001"));
    const list = r.list();
    expect(list).toHaveLength(2);
    expect(list.every((x) => x.cardId === "login-001")).toBe(true);
    // Both ids present and distinct.
    expect(new Set(list.map((x) => x.id)).size).toBe(2);
  });
});
