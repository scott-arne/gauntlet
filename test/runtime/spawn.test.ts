import { describe, test, expect } from "bun:test";
import { spawn, spawnSync } from "../../src/runtime/spawn";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("runtime/spawn", () => {
  test("spawnSync captures stdout and exit code 0", () => {
    const r = spawnSync(["sh", "-c", "echo hello"]);
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe("hello\n");
  });

  test("spawnSync captures stderr and non-zero exit", () => {
    const r = spawnSync(["sh", "-c", "echo oops 1>&2; exit 3"]);
    expect(r.exitCode).toBe(3);
    expect(new TextDecoder().decode(r.stderr)).toBe("oops\n");
  });

  test("spawn streams stdout", async () => {
    const proc = spawn(["sh", "-c", "echo streamed"]);
    const out = await readAll(proc.stdout);
    expect(out).toBe("streamed\n");
  });

  test("spawn writes to stdin and reads echoed bytes", async () => {
    const proc = spawn(["sh", "-c", "cat"]);
    proc.stdin.write("ping\n");
    proc.stdin.flush();

    // Read enough to see the echo, then close stdin so cat exits and
    // stdout closes cleanly.
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!buf.includes("ping\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    proc.kill();
    reader.releaseLock();
    expect(buf).toContain("ping\n");
  });

  test("spawn kill stops a long-running process", async () => {
    const proc = spawn(["sh", "-c", "sleep 30"]);
    proc.kill();
    // If kill works, stdout closes promptly.
    const out = await readAll(proc.stdout);
    expect(out).toBe("");
  });
});

describe("spawn options + new fields", () => {
  test("cwd option puts the child in the named directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-cwd-"));
    try {
      const proc = spawn(["sh", "-c", "pwd"], { cwd: dir });
      const out = await readAll(proc.stdout);
      // macOS canonicalizes /var → /private/var; accept either.
      expect(out.trim().endsWith(dir) || out.trim() === dir).toBe(true);
      await proc.exited;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pid is the child's pid; exited resolves to the exit code", async () => {
    const proc = spawn(["sh", "-c", "exit 7"]);
    expect(typeof proc.pid).toBe("number");
    expect(proc.pid).toBeGreaterThan(0);
    const code = await proc.exited;
    expect(code).toBe(7);
  });

  test("exited resolves even if process already exited before await", async () => {
    const proc = spawn(["sh", "-c", "exit 0"]);
    // Sleep long enough that the process has exited by the time we await.
    await new Promise((r) => setTimeout(r, 200));
    const code = await proc.exited;
    expect(code).toBe(0);
  });

  test("detached makes the child a session leader (pid is its own pgid)", async () => {
    const proc = spawn(["sh", "-c", "ps -o pgid= -p $$"], { detached: true });
    const out = (await readAll(proc.stdout)).trim();
    const childPgid = Number(out);
    expect(childPgid).toBe(proc.pid);
    await proc.exited;
  });
});
