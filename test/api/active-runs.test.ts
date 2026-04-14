import { describe, test, expect } from "bun:test";
import { ActiveRunRegistry } from "../../src/api/active-runs";

describe("ActiveRunRegistry", () => {
  const info = (id: string, startedAt: number) => ({
    id,
    title: `Title ${id}`,
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

  test("register replaces existing entry (last-run-wins)", () => {
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
});
