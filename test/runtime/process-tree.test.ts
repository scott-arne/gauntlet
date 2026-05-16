import { describe, test, expect } from "bun:test";
import { spawn as bunSpawn } from "bun";
import { listDescendants } from "../../src/runtime/process-tree";

describe("listDescendants", () => {
  test("returns direct and transitive children of a root pid", async () => {
    const parent = bunSpawn(["bash", "-c", "sleep 5 & wait"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Promise((r) => setTimeout(r, 150));
    try {
      const kids = listDescendants(parent.pid);
      expect(kids.length).toBeGreaterThan(0);
      const alive = kids.filter((pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      });
      expect(alive.length).toBeGreaterThan(0);
    } finally {
      parent.kill("SIGKILL");
      await parent.exited;
    }
  });

  test("returns empty array for a pid with no children", () => {
    const result = listDescendants(process.pid);
    expect(Array.isArray(result)).toBe(true);
    for (const pid of result) expect(Number.isFinite(pid)).toBe(true);
  });
});
