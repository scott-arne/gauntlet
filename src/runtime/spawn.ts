import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
} from "node:child_process";
import { Readable } from "node:stream";

/**
 * Cross-runtime subprocess primitives. Production code calls these instead
 * of `Bun.spawn` / `Bun.spawnSync` so the rest of the codebase stays
 * runtime-agnostic. The adapter chosen at module load is sticky for the
 * lifetime of the process.
 */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export interface SpawnedProcess {
  stdin: { write(data: string | Uint8Array): void; flush(): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(): void;
}

export interface SpawnSyncResult {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export function spawn(argv: string[]): SpawnedProcess {
  return isBun ? spawnViaBun(argv) : spawnViaNode(argv);
}

export function spawnSync(argv: string[]): SpawnSyncResult {
  return isBun ? spawnSyncViaBun(argv) : spawnSyncViaNode(argv);
}

function spawnViaBun(argv: string[]): SpawnedProcess {
  const Bun = (globalThis as { Bun: typeof globalThis.Bun }).Bun;
  const proc = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
  return {
    stdin: {
      write: (d) => { proc.stdin.write(d as string); },
      flush: () => { proc.stdin.flush(); },
    },
    stdout: proc.stdout,
    stderr: proc.stderr,
    kill: () => { proc.kill(); },
  };
}

function spawnViaNode(argv: string[]): SpawnedProcess {
  const proc = nodeSpawn(argv[0]!, argv.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new Error("Node spawn returned a process with missing stdio");
  }
  return {
    stdin: {
      write: (d) => { proc.stdin!.write(d); },
      // Node's child_process stdin flushes synchronously to the kernel
      // pipe on each write call; there's no equivalent of FileSink.flush.
      flush: () => {},
    },
    stdout: Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(proc.stderr) as unknown as ReadableStream<Uint8Array>,
    kill: () => { proc.kill(); },
  };
}

function spawnSyncViaBun(argv: string[]): SpawnSyncResult {
  const Bun = (globalThis as { Bun: typeof globalThis.Bun }).Bun;
  const r = Bun.spawnSync(argv);
  return {
    exitCode: r.exitCode,
    stdout: new Uint8Array(r.stdout),
    stderr: new Uint8Array(r.stderr),
  };
}

function spawnSyncViaNode(argv: string[]): SpawnSyncResult {
  const r = nodeSpawnSync(argv[0]!, argv.slice(1));
  return {
    exitCode: r.status,
    stdout: r.stdout ? new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength) : new Uint8Array(),
    stderr: r.stderr ? new Uint8Array(r.stderr.buffer, r.stderr.byteOffset, r.stderr.byteLength) : new Uint8Array(),
  };
}
