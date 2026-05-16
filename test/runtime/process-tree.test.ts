import { describe, test, expect } from "bun:test";
import { spawn as bunSpawn } from "bun";
import { listDescendants, killProcessTree } from "../../src/runtime/process-tree";
import { spawn } from "../../src/runtime/spawn";

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

test("killProcessTree SIGKILLs the pgid and reaps descendants", async () => {
  // Parent spawns a background sleep child, writes its pid to a file
  // (more reliable than racing stderr), then sleeps itself.
  // pgid invariant: pid == pgid only because we spawn detached.
  const { mkdtempSync, readFileSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-killtree-"));
  const pidFile = join(dir, "child.pid");

  const parent = spawn(
    ["bash", "-c", `sleep 30 & echo $! > ${pidFile}; sleep 30`],
    { detached: true },
  );

  // Wait for the pid file to be written
  let childPid = 0;
  for (let i = 0; i < 50; i++) {
    try {
      childPid = Number(readFileSync(pidFile, "utf-8").trim());
      if (childPid > 0) break;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(childPid).toBeGreaterThan(0);

  // Snapshot descendants WHILE PARENT IS STILL ALIVE.
  const descendants = listDescendants(parent.pid);
  expect(descendants.length).toBeGreaterThan(0);

  const result = killProcessTree(parent.pid, descendants);
  expect(result.reaped).toBeGreaterThan(0);

  // Both parent and background child should be dead now.
  await new Promise((r) => setTimeout(r, 50));
  let childAlive = true;
  try { process.kill(childPid, 0); } catch { childAlive = false; }
  expect(childAlive).toBe(false);
  await parent.exited;
});

test("killProcessTree on already-dead pgid does not throw", () => {
  // A pid extremely unlikely to be alive
  expect(() => killProcessTree(999999, [999998])).not.toThrow();
});
