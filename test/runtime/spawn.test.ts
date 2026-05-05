import { describe, test, expect } from "bun:test";
import { spawn, spawnSync } from "../../src/runtime/spawn";

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
