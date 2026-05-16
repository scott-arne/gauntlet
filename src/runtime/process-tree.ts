import { spawnSync } from "./spawn";

/**
 * Enumerate every descendant of `root` (children, grandchildren, ...).
 * Uses `ps -ax -o pid,ppid` and walks the parent → child relation.
 * POSIX-portable; works on both macOS and Linux. Returns descendant
 * pids only — `root` itself is excluded.
 */
export function listDescendants(root: number): number[] {
  const ps = spawnSync(["ps", "-ax", "-o", "pid=,ppid="]);
  if (ps.exitCode !== 0) return [];
  const text = new TextDecoder().decode(ps.stdout);
  const children = new Map<number, number[]>();
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const arr = children.get(ppid) ?? [];
    arr.push(pid);
    children.set(ppid, arr);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of children.get(cur) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}
