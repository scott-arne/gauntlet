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

export interface SpawnOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /**
   * When true, the child becomes a session leader (calls `setsid()` on
   * POSIX). Its pid equals its pgid, so `process.kill(-pid, signal)`
   * targets the entire process group — used by callers that need to reap
   * the whole tree at cleanup time (e.g. `src/adapters/cli/adapter.ts`).
   */
  detached?: boolean;
}

export interface SpawnedProcess {
  pid: number;
  stdin: { write(data: string | Uint8Array): void; flush(): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(): void;
  /**
   * Resolves with the child's exit code when it exits. Resolves with -1
   * when the child was killed by a signal (signal info isn't part of the
   * contract; callers that care can inspect the signal separately).
   * Safe to await after the child has already exited.
   */
  exited: Promise<number>;
}

export interface SpawnSyncResult {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export function spawn(argv: string[], options?: SpawnOptions): SpawnedProcess {
  return isBun ? spawnViaBun(argv, options) : spawnViaNode(argv, options);
}

export function spawnSync(argv: string[]): SpawnSyncResult {
  return isBun ? spawnSyncViaBun(argv) : spawnSyncViaNode(argv);
}

function spawnViaBun(argv: string[], options?: SpawnOptions): SpawnedProcess {
  const Bun = (globalThis as { Bun: typeof globalThis.Bun }).Bun;
  const proc = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: options?.cwd,
    // Bun.spawn calls setsid() in the child on POSIX when detached: true.
    // We don't `unref` — we want to await proc.exited at close time.
    ...(options?.detached ? { detached: true } : {}),
  }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
  return {
    pid: proc.pid,
    stdin: {
      write: (d) => { proc.stdin.write(d as string); },
      flush: () => { proc.stdin.flush(); },
    },
    stdout: proc.stdout,
    stderr: proc.stderr,
    kill: () => { proc.kill(); },
    exited: proc.exited.then((code) => code ?? -1),
  };
}

function spawnViaNode(argv: string[], options?: SpawnOptions): SpawnedProcess {
  const proc = nodeSpawn(argv[0]!, argv.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options?.cwd,
    detached: options?.detached === true,
  });
  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new Error("Node spawn returned a process with missing stdio");
  }
  if (proc.pid === undefined) {
    throw new Error("Node spawn returned a process with no pid");
  }
  const exited = new Promise<number>((resolve) => {
    if (proc.exitCode !== null) {
      resolve(proc.exitCode);
      return;
    }
    proc.once("exit", (code, _signal) => resolve(code ?? -1));
  });
  return {
    pid: proc.pid,
    stdin: {
      write: (d) => { proc.stdin!.write(d); },
      // Node's child_process stdin flushes synchronously to the kernel
      // pipe on each write call; there's no equivalent of FileSink.flush.
      flush: () => {},
    },
    stdout: Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(proc.stderr) as unknown as ReadableStream<Uint8Array>,
    kill: () => { proc.kill(); },
    exited,
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
