# watch_logs + wake_on_idle_log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two tools (`watch_logs`, `wake_on_idle_log`) to Gauntlet's shared tool surface that let the agent block one inference turn until watched files go idle, a new file matches a watched glob, or `timeout_ms` elapses. Replaces `sleep`-and-poll on long-haul runs. Plus a small empty-end_turn safety net in the runner. Plus HOWTO patches in superpowers-evals.

**Architecture:** A polling-based `WatchManager` (1s poll interval, tracks size + mtime per file) lives in `buildSharedTools` alongside `bash`/`read`/`fetch_credential`. Two thin tools wrap it. `wake_on_idle_log` is the only blocking call — it loops on `manager.scan()` until idle / new_file / timeout (≤ 240_000ms, hard-clamped). The TUI adapter is untouched.

**Tech Stack:** Bun + TypeScript, `bun:test`, polling `fs.statSync` (deterministic and cross-platform — `fs.watch` is unreliable on macOS), `Bun.Glob` for glob matching.

**Spec:** `docs/superpowers/specs/2026-05-27-watch-logs-wake-on-idle-log-spec.md`
**Ticket:** PRI-1864

---

## File map

**Gauntlet — create:**
- `src/agent/watch-manager.ts` — pure watcher state, `WatchManager` class
- `src/agent/watch-logs-tool.ts` — `buildWatchLogsTool({ manager })`
- `src/agent/wake-on-idle-log-tool.ts` — `buildWakeOnIdleLogTool({ manager })`
- `test/agent/watch-manager.test.ts`
- `test/agent/watch-logs-tool.test.ts`
- `test/agent/wake-on-idle-log-tool.test.ts`
- `test/agent/empty-end-turn-safety-net.test.ts`

**Gauntlet — modify:**
- `src/agent/shared-tools.ts` — instantiate `WatchManager`, register both new tools in `definitions()` / `canExecute()` / `execute()`
- `src/models/provider.ts` — extend `ToolDefinition` with optional `maxExecutionMs`
- `src/agent/agent.ts:382-407` — per-call tool timeout lookup; honor `maxExecutionMs` from the matched `ToolDefinition`
- `src/agent/agent.ts:462-475` — add empty-end_turn soft-retry before returning `investigate` (requires extracting the response-dispatch into a helper since `response` is currently `const`)

**superpowers-evals — modify:**
- `coding-agents/codex-context/HOWTO.md` — "Waiting for Codex to work" section, demote `sleep`-poll
- `coding-agents/claude-context/HOWTO.md` — "Waiting for Claude to work" section, demote `sleep`-poll

---

## Constants (used throughout)

```ts
export const WATCH_POLL_INTERVAL_MS = 1000;
export const WAKE_IDLE_MS_MIN = 5_000;
export const WAKE_IDLE_MS_DEFAULT = 60_000;
export const WAKE_TIMEOUT_MS_MAX = 240_000;
export const WAKE_TIMEOUT_MS_DEFAULT = 240_000;
```

Define these as named exports in `src/agent/watch-manager.ts` so tests and tools share one source of truth.

---

## Task 1: WatchManager — registration + state shape

**Files:**
- Create: `src/agent/watch-manager.ts`
- Test: `test/agent/watch-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "bun:test";
import { WatchManager } from "../../src/agent/watch-manager";

describe("WatchManager.addGlob", () => {
  test("returns the current glob set after registration", () => {
    const m = new WatchManager();
    expect(m.currentGlobs()).toEqual([]);
    m.addGlob("/tmp/foo/*.log");
    expect(m.currentGlobs()).toEqual(["/tmp/foo/*.log"]);
  });

  test("is idempotent for duplicate globs", () => {
    const m = new WatchManager();
    m.addGlob("/tmp/foo/*.log");
    m.addGlob("/tmp/foo/*.log");
    expect(m.currentGlobs()).toEqual(["/tmp/foo/*.log"]);
  });

  test("accumulates distinct globs in registration order", () => {
    const m = new WatchManager();
    m.addGlob("/tmp/a/*.log");
    m.addGlob("/tmp/b/*.log");
    expect(m.currentGlobs()).toEqual(["/tmp/a/*.log", "/tmp/b/*.log"]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test test/agent/watch-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement minimal WatchManager**

```ts
// src/agent/watch-manager.ts
export const WATCH_POLL_INTERVAL_MS = 1000;
export const WAKE_IDLE_MS_MIN = 5_000;
export const WAKE_IDLE_MS_DEFAULT = 60_000;
export const WAKE_TIMEOUT_MS_MAX = 240_000;
export const WAKE_TIMEOUT_MS_DEFAULT = 240_000;

export class WatchManager {
  private globs: string[] = [];

  addGlob(glob: string): void {
    if (!this.globs.includes(glob)) this.globs.push(glob);
  }

  currentGlobs(): string[] {
    return [...this.globs];
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test test/agent/watch-manager.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/watch-manager.ts test/agent/watch-manager.test.ts
git commit -m "feat(watch): WatchManager registration + glob set (PRI-1864)"
```

---

## Task 2: WatchManager — initial scan against the filesystem

**Files:**
- Modify: `src/agent/watch-manager.ts`
- Modify: `test/agent/watch-manager.test.ts`

The scan returns an event tuple describing what changed since the last call. Three event kinds: `new_file` (file appeared matching some glob), `appended` (known file grew or mtime updated), and nothing.

- [ ] **Step 1: Write failing tests**

Add to `test/agent/watch-manager.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WatchManager } from "../../src/agent/watch-manager";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gauntlet-watch-test-"));
}

describe("WatchManager.scan", () => {
  test("first scan with existing matching file returns it as new_file", () => {
    const dir = freshDir();
    const file = join(dir, "a.log");
    writeFileSync(file, "hello\n");

    const m = new WatchManager();
    m.addGlob(join(dir, "*.log"));
    const events = m.scan();

    expect(events.newFiles).toEqual([file]);
    expect(events.appended).toEqual([]);
  });

  test("second scan with no changes returns no events", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "a.log"), "hello\n");

    const m = new WatchManager();
    m.addGlob(join(dir, "*.log"));
    m.scan(); // first scan picks up file
    const events = m.scan(); // second scan should be empty

    expect(events.newFiles).toEqual([]);
    expect(events.appended).toEqual([]);
  });

  test("append to known file fires `appended`", () => {
    const dir = freshDir();
    const file = join(dir, "a.log");
    writeFileSync(file, "hello\n");

    const m = new WatchManager();
    m.addGlob(join(dir, "*.log"));
    m.scan();
    appendFileSync(file, "world\n");
    const events = m.scan();

    expect(events.appended).toEqual([file]);
    expect(events.newFiles).toEqual([]);
  });

  test("non-existent directory at registration matches nothing, gracefully", () => {
    const m = new WatchManager();
    m.addGlob("/tmp/this-dir-does-not-exist-zxcvb/*.log");
    const events = m.scan();
    expect(events.newFiles).toEqual([]);
    expect(events.appended).toEqual([]);
  });

  test("file appearing later is picked up as new_file", () => {
    const dir = freshDir();
    const m = new WatchManager();
    m.addGlob(join(dir, "*.log"));
    m.scan(); // empty
    const file = join(dir, "late.log");
    writeFileSync(file, "x\n");
    const events = m.scan();
    expect(events.newFiles).toEqual([file]);
  });

  test("truncation also counts as activity (appended)", () => {
    const dir = freshDir();
    const file = join(dir, "a.log");
    writeFileSync(file, "hellohello\n");

    const m = new WatchManager();
    m.addGlob(join(dir, "*.log"));
    m.scan();
    writeFileSync(file, "x\n"); // shrinks
    const events = m.scan();
    expect(events.appended).toEqual([file]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test test/agent/watch-manager.test.ts`
Expected: FAIL — `m.scan is not a function`.

- [ ] **Step 3: Implement `scan()`**

Add to `src/agent/watch-manager.ts`:

```ts
import { statSync } from "fs";
import { Glob } from "bun";

interface FileState {
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  newFiles: string[];
  appended: string[];
}

export class WatchManager {
  private globs: string[] = [];
  private known = new Map<string, FileState>();

  addGlob(glob: string): void {
    if (!this.globs.includes(glob)) this.globs.push(glob);
  }

  currentGlobs(): string[] {
    return [...this.globs];
  }

  currentWatches(): string[] {
    return [...this.known.keys()];
  }

  scan(): ScanResult {
    const newFiles: string[] = [];
    const appended: string[] = [];

    for (const pattern of this.globs) {
      let matches: Iterable<string>;
      try {
        const g = new Glob(pattern);
        matches = g.scanSync({ absolute: true, onlyFiles: true });
      } catch {
        // Glob's root dir doesn't exist yet — Codex `$CODEX_HOME/sessions`
        // before launch is the canonical case. Skip this pattern this poll.
        continue;
      }
      for (const path of matches) {
        let st: FileState | undefined;
        try {
          const s = statSync(path);
          st = { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          continue; // raced removal
        }
        const prior = this.known.get(path);
        if (!prior) {
          newFiles.push(path);
          this.known.set(path, st);
        } else if (st.size !== prior.size || st.mtimeMs !== prior.mtimeMs) {
          appended.push(path);
          this.known.set(path, st);
        }
      }
    }
    return { newFiles, appended };
  }
}
```

`Bun.Glob` is built in; no new dependency. `scanSync({ absolute: true, onlyFiles: true })` does the recursive expansion when `**` is in the pattern. The pattern itself is taken verbatim — callers must give absolute or already-resolved paths.

**Note:** `Glob.scanSync` throws (not returns empty) when the glob's root directory doesn't exist. Wrap it in `try/catch` so a held glob doesn't crash the polling loop. This is the motivating case — Codex's `$CODEX_HOME/sessions/` doesn't exist until Codex starts writing rollouts.

**Note on append-collapse:** two appends inside the same poll window register as one `appended` event. That's fine for the idle-timer reset semantics; document it on the `ScanResult.appended` field as "deduplicated per scan window."

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test test/agent/watch-manager.test.ts`
Expected: PASS (8 tests total — 3 from Task 1, 5 new — plus 1 missed; recount: registration 3 + scan 6 = 9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/watch-manager.ts test/agent/watch-manager.test.ts
git commit -m "feat(watch): WatchManager.scan picks up new + appended files (PRI-1864)"
```

---

## Task 3: WatchManager — `waitForWake` blocking primitive

**Files:**
- Modify: `src/agent/watch-manager.ts`
- Modify: `test/agent/watch-manager.test.ts`

This is the core blocking loop. It polls `scan()` at `WATCH_POLL_INTERVAL_MS`, tracks last-activity timestamp, returns on idle / new_file / timeout.

- [ ] **Step 1: Write failing tests**

Add to `test/agent/watch-manager.test.ts`:

```ts
describe("WatchManager.waitForWake", () => {
  test("returns timeout when nothing happens (with fast poll override)", async () => {
    const dir = freshDir();
    const m = new WatchManager();
    m.addGlob(join(dir, "*.log"));

    const result = await m.waitForWake({
      idleMs: 1_000_000, // unreachable
      timeoutMs: 300,
      pollIntervalMs: 50,
    });
    expect(result.reason).toBe("timeout");
  });

  test("returns new_file when a matching file appears", async () => {
    const dir = freshDir();
    const m = new WatchManager();
    m.addGlob(join(dir, "*.log"));

    const wakePromise = m.waitForWake({
      idleMs: 1_000_000,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });
    setTimeout(() => writeFileSync(join(dir, "fresh.log"), "x\n"), 100);
    const result = await wakePromise;

    expect(result.reason).toBe("new_file");
    expect(result.path).toEqual(join(dir, "fresh.log"));
  });

  test("returns idle when no activity for idleMs", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "a.log"), "x\n");
    const m = new WatchManager();
    m.addGlob(join(dir, "*.log"));
    m.scan(); // consume initial new_file so it doesn't fire

    const result = await m.waitForWake({
      idleMs: 200,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });

    expect(result.reason).toBe("idle");
    expect(result.lastActivityMsAgo).toBeGreaterThanOrEqual(200);
  });

  test("append resets the idle timer", async () => {
    const dir = freshDir();
    const file = join(dir, "a.log");
    writeFileSync(file, "x\n");
    const m = new WatchManager();
    m.addGlob(join(dir, "*.log"));
    m.scan(); // consume initial new_file

    const wakePromise = m.waitForWake({
      idleMs: 400,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });
    // Append twice during the wait, each before idleMs elapses
    setTimeout(() => appendFileSync(file, "y\n"), 200);
    setTimeout(() => appendFileSync(file, "z\n"), 500);
    const start = Date.now();
    const result = await wakePromise;
    const elapsed = Date.now() - start;

    expect(result.reason).toBe("idle");
    // Last append at ~500ms; idle fires after 400ms more ≈ 900ms total.
    // Generous lower bound — CI scheduling can jitter the timers.
    expect(elapsed).toBeGreaterThan(700);
    expect(result.lastActivityMsAgo).toBeGreaterThanOrEqual(400);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `bun test test/agent/watch-manager.test.ts`
Expected: FAIL — `m.waitForWake is not a function`.

- [ ] **Step 3: Implement `waitForWake`**

Add to `src/agent/watch-manager.ts`:

```ts
export interface WaitForWakeOptions {
  idleMs: number;
  timeoutMs: number;
  /** Override for tests; production uses WATCH_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
}

export interface WakeResult {
  reason: "idle" | "new_file" | "timeout";
  path?: string;
  lastActivityMsAgo: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class WatchManager {
  // ... existing fields ...

  async waitForWake(opts: WaitForWakeOptions): Promise<WakeResult> {
    const pollMs = opts.pollIntervalMs ?? WATCH_POLL_INTERVAL_MS;
    const startedAt = Date.now();
    let lastActivityAt = Date.now();

    while (true) {
      const events = this.scan();
      if (events.newFiles.length > 0) {
        return {
          reason: "new_file",
          path: events.newFiles[0],
          lastActivityMsAgo: 0,
        };
      }
      if (events.appended.length > 0) {
        lastActivityAt = Date.now();
      }

      const now = Date.now();
      const msSinceActivity = now - lastActivityAt;
      const msSinceStart = now - startedAt;

      if (msSinceActivity >= opts.idleMs) {
        return { reason: "idle", lastActivityMsAgo: msSinceActivity };
      }
      if (msSinceStart >= opts.timeoutMs) {
        return { reason: "timeout", lastActivityMsAgo: msSinceActivity };
      }

      await sleep(pollMs);
    }
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test test/agent/watch-manager.test.ts`
Expected: PASS (all WatchManager tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/watch-manager.ts test/agent/watch-manager.test.ts
git commit -m "feat(watch): WatchManager.waitForWake blocks on idle/new_file/timeout (PRI-1864)"
```

---

## Task 4: WatchManager — concurrent-call guard

**Files:**
- Modify: `src/agent/watch-manager.ts`
- Modify: `test/agent/watch-manager.test.ts`

The spec requires that a second `wake_on_idle_log` call while one is in flight returns immediately with `reason: "concurrent_call"`. Implement at the manager level so the tool layer stays thin.

- [ ] **Step 1: Write failing test**

```ts
describe("WatchManager concurrency", () => {
  test("second waitForWake while one is in flight returns concurrent_call", async () => {
    const dir = freshDir();
    const m = new WatchManager();
    m.addGlob(join(dir, "*.log"));

    const p1 = m.waitForWake({ idleMs: 500, timeoutMs: 5_000, pollIntervalMs: 50 });
    // `waitInFlight = true` is set synchronously at function entry before
    // the first `await`, so the second call sees the guard on the next
    // microtask without needing a sleep.
    const r2 = await m.waitForWake({ idleMs: 1, timeoutMs: 1, pollIntervalMs: 1 });
    expect(r2.reason).toBe("concurrent_call");

    await p1; // let the first one finish so the test runner doesn't dangle
  });
});
```

Extend `WakeResult["reason"]` to include `"concurrent_call"`.

- [ ] **Step 2: Run test, verify failure**

Run: `bun test test/agent/watch-manager.test.ts`
Expected: FAIL — second call returns `idle` or `timeout`, not `concurrent_call`.

- [ ] **Step 3: Implement the guard**

Update `src/agent/watch-manager.ts`:

```ts
export interface WakeResult {
  reason: "idle" | "new_file" | "timeout" | "concurrent_call";
  path?: string;
  lastActivityMsAgo: number;
}

export class WatchManager {
  // ... existing fields ...
  private waitInFlight = false;

  async waitForWake(opts: WaitForWakeOptions): Promise<WakeResult> {
    if (this.waitInFlight) {
      return { reason: "concurrent_call", lastActivityMsAgo: 0 };
    }
    this.waitInFlight = true;
    try {
      // ... existing loop body unchanged ...
    } finally {
      this.waitInFlight = false;
    }
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test test/agent/watch-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/watch-manager.ts test/agent/watch-manager.test.ts
git commit -m "feat(watch): reject concurrent waitForWake calls (PRI-1864)"
```

---

## Task 5: `watch_logs` tool

**Files:**
- Create: `src/agent/watch-logs-tool.ts`
- Test: `test/agent/watch-logs-tool.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, test, expect } from "bun:test";
import { WatchManager } from "../../src/agent/watch-manager";
import { buildWatchLogsTool } from "../../src/agent/watch-logs-tool";
import type { EvidenceLogger } from "../../src/evidence/logger";

function noopLogger(): EvidenceLogger {
  return { logEvent: () => {} } as unknown as EvidenceLogger;
}

describe("watch_logs tool", () => {
  test("definition declares name and required glob param", () => {
    const m = new WatchManager();
    const tool = buildWatchLogsTool({ manager: m });
    expect(tool.definition.name).toBe("watch_logs");
    const params = tool.definition.parameters as Record<string, unknown>;
    expect((params.properties as Record<string, unknown>).glob).toBeDefined();
    expect((params.required as string[])).toContain("glob");
  });

  test("registers a glob and returns watching list", async () => {
    const m = new WatchManager();
    const tool = buildWatchLogsTool({ manager: m });
    const result = await tool.execute({ glob: "/tmp/foo/*.log" }, noopLogger());
    const payload = JSON.parse(result.text);
    expect(payload.watching).toEqual(["/tmp/foo/*.log"]);
  });

  test("repeat call accumulates and is idempotent", async () => {
    const m = new WatchManager();
    const tool = buildWatchLogsTool({ manager: m });
    await tool.execute({ glob: "/tmp/a/*.log" }, noopLogger());
    await tool.execute({ glob: "/tmp/b/*.log" }, noopLogger());
    await tool.execute({ glob: "/tmp/a/*.log" }, noopLogger());
    const result = await tool.execute({ glob: "/tmp/b/*.log" }, noopLogger());
    const payload = JSON.parse(result.text);
    expect(payload.watching).toEqual(["/tmp/a/*.log", "/tmp/b/*.log"]);
  });

  test("missing glob returns error", async () => {
    const m = new WatchManager();
    const tool = buildWatchLogsTool({ manager: m });
    const result = await tool.execute({}, noopLogger());
    expect(result.text).toContain("error");
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `bun test test/agent/watch-logs-tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tool**

```ts
// src/agent/watch-logs-tool.ts
import { textResult, type ToolDefinition, type ToolResult } from "../models/provider";
import type { EvidenceLogger } from "../evidence/logger";
import type { WatchManager } from "./watch-manager";

const WATCH_LOGS_DESCRIPTION =
  "Register a file path or glob to monitor for activity. Required before " +
  "wake_on_idle_log can observe those paths. Idempotent and additive — " +
  "calls accumulate; the result echoes the full watch set.";

export interface WatchLogsTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, logger: EvidenceLogger): Promise<ToolResult>;
}

export function buildWatchLogsTool(opts: { manager: WatchManager }): WatchLogsTool {
  const definition: ToolDefinition = {
    name: "watch_logs",
    description: WATCH_LOGS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        glob: {
          type: "string",
          description:
            "Absolute path or glob pattern (supports `**` for recursive). " +
            "Example: /home/user/.foo/sessions/**/rollout-*.jsonl",
        },
      },
      required: ["glob"],
    },
  };

  const execute = async (
    args: Record<string, unknown>,
    _logger: EvidenceLogger,
  ): Promise<ToolResult> => {
    const glob = args.glob;
    if (typeof glob !== "string" || glob.length === 0) {
      return textResult(JSON.stringify({ error: "glob (string) is required" }));
    }
    opts.manager.addGlob(glob);
    return textResult(JSON.stringify({ watching: opts.manager.currentGlobs() }));
  };

  return { definition, execute };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test test/agent/watch-logs-tool.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/watch-logs-tool.ts test/agent/watch-logs-tool.test.ts
git commit -m "feat(watch): watch_logs tool wraps WatchManager.addGlob (PRI-1864)"
```

---

## Task 6: `wake_on_idle_log` tool

**Files:**
- Create: `src/agent/wake-on-idle-log-tool.ts`
- Test: `test/agent/wake-on-idle-log-tool.test.ts`

The tool clamps `timeout_ms` and `idle_ms` to their allowed range, rejects invalid (negative / zero / non-number) values, applies defaults, calls `manager.waitForWake`, and serializes the result.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WatchManager, WAKE_TIMEOUT_MS_MAX, WAKE_IDLE_MS_MIN } from "../../src/agent/watch-manager";
import { buildWakeOnIdleLogTool } from "../../src/agent/wake-on-idle-log-tool";
import type { EvidenceLogger } from "../../src/evidence/logger";

function noopLogger(): EvidenceLogger {
  return { logEvent: () => {} } as unknown as EvidenceLogger;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gauntlet-wake-test-"));
}

describe("wake_on_idle_log tool", () => {
  test("returns timeout reason when nothing happens", async () => {
    const m = new WatchManager();
    const tool = buildWakeOnIdleLogTool({ manager: m });
    const result = await tool.execute(
      { idle_ms: 1_000_000, timeout_ms: 5_000, poll_interval_ms: 50 },
      noopLogger(),
    );
    const payload = JSON.parse(result.text);
    expect(payload.reason).toBe("timeout");
  });

  test("clamps timeout_ms above ceiling and surfaces applied value", async () => {
    const m = new WatchManager();
    const tool = buildWakeOnIdleLogTool({ manager: m });
    const result = await tool.execute(
      { idle_ms: 60_000, timeout_ms: 999_999, poll_interval_ms: 50 },
      noopLogger(),
    );
    const payload = JSON.parse(result.text);
    expect(payload.applied_timeout_ms).toBe(WAKE_TIMEOUT_MS_MAX);
    expect(payload.applied_idle_ms).toBe(60_000);
  });

  test("clamps idle_ms below floor and surfaces applied value", async () => {
    const m = new WatchManager();
    const tool = buildWakeOnIdleLogTool({ manager: m });
    const result = await tool.execute(
      { idle_ms: 1, timeout_ms: 5_000, poll_interval_ms: 50 },
      noopLogger(),
    );
    const payload = JSON.parse(result.text);
    expect(payload.applied_idle_ms).toBe(WAKE_IDLE_MS_MIN);
    expect(payload.applied_timeout_ms).toBe(5_000);
  });

  test("rejects negative timeout_ms", async () => {
    const m = new WatchManager();
    const tool = buildWakeOnIdleLogTool({ manager: m });
    const result = await tool.execute(
      { idle_ms: 60_000, timeout_ms: -1 },
      noopLogger(),
    );
    const payload = JSON.parse(result.text);
    expect(payload.error).toBeDefined();
  });

  test("rejects non-number idle_ms", async () => {
    const m = new WatchManager();
    const tool = buildWakeOnIdleLogTool({ manager: m });
    const result = await tool.execute(
      { idle_ms: "fast", timeout_ms: 5_000 },
      noopLogger(),
    );
    const payload = JSON.parse(result.text);
    expect(payload.error).toBeDefined();
  });

  test("returns new_file reason when a matching file appears", async () => {
    const dir = freshDir();
    const m = new WatchManager();
    m.addGlob(join(dir, "*.log"));
    const tool = buildWakeOnIdleLogTool({ manager: m });

    setTimeout(() => writeFileSync(join(dir, "wake.log"), "x\n"), 100);

    const result = await tool.execute(
      { idle_ms: 60_000, timeout_ms: 5_000, poll_interval_ms: 50 },
      noopLogger(),
    );
    const payload = JSON.parse(result.text);
    expect(payload.reason).toBe("new_file");
    expect(payload.path).toEqual(join(dir, "wake.log"));
  });

  test("result includes current watching list", async () => {
    const m = new WatchManager();
    m.addGlob("/tmp/x/*.log");
    const tool = buildWakeOnIdleLogTool({ manager: m });
    const result = await tool.execute(
      { idle_ms: 1_000_000, timeout_ms: 50, poll_interval_ms: 10 },
      noopLogger(),
    );
    const payload = JSON.parse(result.text);
    expect(payload.watching).toEqual(["/tmp/x/*.log"]);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `bun test test/agent/wake-on-idle-log-tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tool**

```ts
// src/agent/wake-on-idle-log-tool.ts
import { textResult, type ToolDefinition, type ToolResult } from "../models/provider";
import type { EvidenceLogger } from "../evidence/logger";
import {
  WAKE_IDLE_MS_DEFAULT,
  WAKE_IDLE_MS_MIN,
  WAKE_TIMEOUT_MS_DEFAULT,
  WAKE_TIMEOUT_MS_MAX,
  type WatchManager,
} from "./watch-manager";

const WAKE_ON_IDLE_LOG_DESCRIPTION =
  "Block one inference turn until watched logs have been quiet for " +
  "idle_ms, a new file matches a watched glob, or timeout_ms elapses. " +
  "Prefer this over sleep-based polling when waiting on external work to " +
  "progress or complete. Keep timeout_ms ≤ 240000 (4 minutes) — longer " +
  "waits lose the model context cache.";

export interface WakeOnIdleLogTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, logger: EvidenceLogger): Promise<ToolResult>;
}

interface ParsedArgs {
  idleMs: number;
  timeoutMs: number;
  pollIntervalMs?: number;
}

function parseArgs(args: Record<string, unknown>): ParsedArgs | { error: string } {
  const rawIdle = args.idle_ms;
  const rawTimeout = args.timeout_ms;
  const rawPoll = args.poll_interval_ms;

  let idleMs = WAKE_IDLE_MS_DEFAULT;
  let timeoutMs = WAKE_TIMEOUT_MS_DEFAULT;

  if (rawIdle !== undefined) {
    if (typeof rawIdle !== "number" || !Number.isFinite(rawIdle) || rawIdle <= 0) {
      return { error: "idle_ms must be a positive number" };
    }
    idleMs = rawIdle;
  }
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      return { error: "timeout_ms must be a positive number" };
    }
    timeoutMs = rawTimeout;
  }

  if (idleMs < WAKE_IDLE_MS_MIN) idleMs = WAKE_IDLE_MS_MIN;
  if (timeoutMs > WAKE_TIMEOUT_MS_MAX) timeoutMs = WAKE_TIMEOUT_MS_MAX;

  let pollIntervalMs: number | undefined;
  if (rawPoll !== undefined) {
    if (typeof rawPoll !== "number" || !Number.isFinite(rawPoll) || rawPoll <= 0) {
      return { error: "poll_interval_ms must be a positive number" };
    }
    pollIntervalMs = rawPoll;
  }

  return { idleMs, timeoutMs, pollIntervalMs };
}

export function buildWakeOnIdleLogTool(opts: {
  manager: WatchManager;
}): WakeOnIdleLogTool {
  const definition: ToolDefinition = {
    name: "wake_on_idle_log",
    description: WAKE_ON_IDLE_LOG_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        idle_ms: {
          type: "number",
          description: `No-activity duration that triggers the idle wake. Default ${WAKE_IDLE_MS_DEFAULT}, minimum ${WAKE_IDLE_MS_MIN}.`,
        },
        timeout_ms: {
          type: "number",
          description: `Absolute deadline. Default ${WAKE_TIMEOUT_MS_DEFAULT}, maximum ${WAKE_TIMEOUT_MS_MAX} (cache TTL).`,
        },
        poll_interval_ms: {
          type: "number",
          description: "Override poll interval. For tests only; omit in normal use.",
        },
      },
      required: [],
    },
  };

  const execute = async (
    args: Record<string, unknown>,
    _logger: EvidenceLogger,
  ): Promise<ToolResult> => {
    const parsed = parseArgs(args);
    if ("error" in parsed) {
      return textResult(JSON.stringify({ error: parsed.error }));
    }
    const wake = await opts.manager.waitForWake({
      idleMs: parsed.idleMs,
      timeoutMs: parsed.timeoutMs,
      pollIntervalMs: parsed.pollIntervalMs,
    });
    const payload: Record<string, unknown> = {
      reason: wake.reason,
      last_activity_ms_ago: wake.lastActivityMsAgo,
      applied_idle_ms: parsed.idleMs,
      applied_timeout_ms: parsed.timeoutMs,
      watching: opts.manager.currentGlobs(),
    };
    if (wake.path !== undefined) payload.path = wake.path;
    return textResult(JSON.stringify(payload));
  };

  return { definition, execute };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test test/agent/wake-on-idle-log-tool.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/wake-on-idle-log-tool.ts test/agent/wake-on-idle-log-tool.test.ts
git commit -m "feat(watch): wake_on_idle_log tool with clamp + validation (PRI-1864)"
```

---

## Task 6.5: Extend `ToolDefinition` with `maxExecutionMs`

**Files:**
- Modify: `src/models/provider.ts`
- Modify: `src/agent/agent.ts` (per-call timeout lookup)
- Modify: `src/agent/wake-on-idle-log-tool.ts` (set `maxExecutionMs: WAKE_TIMEOUT_MS_MAX`)
- Test: `test/agent/tool-timeout-override.test.ts`

**Why this task exists:** the agent loop races every `executeTool` call against `DEFAULT_TOOL_TIMEOUT_MS = 30000` (`src/agent/agent.ts:23`). Our `wake_on_idle_log` waits up to 240_000ms. Without an override, the agent kills the wake tool at 30s with `Tool "wake_on_idle_log" timed out after 30000ms`, defeating the whole design.

**Approach:** add an optional `maxExecutionMs` to `ToolDefinition`. Per-call timeout = tool's override ?? `options.toolTimeoutMs` ?? `DEFAULT_TOOL_TIMEOUT_MS`. Surgical change in the agent loop's race.

- [ ] **Step 1: Write failing test**

```ts
// test/agent/tool-timeout-override.test.ts
import { describe, test, expect } from "bun:test";
import type { ToolDefinition } from "../../src/models/provider";

describe("ToolDefinition.maxExecutionMs", () => {
  test("type allows optional maxExecutionMs on a tool definition", () => {
    const def: ToolDefinition = {
      name: "slow",
      description: "x",
      parameters: { type: "object", properties: {}, required: [] },
      maxExecutionMs: 240_000,
    };
    expect(def.maxExecutionMs).toBe(240_000);
  });
});
```

This is a typecheck test; if the field doesn't exist on the type, TS fails the build. The agent-loop behavior is exercised indirectly in Task 7's end-to-end test (a `wake_on_idle_log` call with `timeout_ms=5000, poll_interval_ms=50` runs ~5s, longer than would survive the default 30s race, but well within the override; we can also write a direct test by mocking `adapter.executeTool` to sleep > 30s).

- [ ] **Step 2: Add the field to `ToolDefinition`**

`src/models/provider.ts` — find the `ToolDefinition` interface and add:

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
  /**
   * Optional per-tool override for the agent loop's `executeTool` timeout.
   * When unset, the loop uses `options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS`.
   * Tools that legitimately need to block for minutes (e.g. wake_on_idle_log)
   * declare this; bash, read, etc. leave it unset.
   */
  maxExecutionMs?: number;
}
```

(Match the exact existing field set in `provider.ts` — the above is illustrative; the engineer must keep the rest of the interface intact.)

- [ ] **Step 3: Honor it in the agent loop**

Patch `src/agent/agent.ts` around line 382-400. Replace:

```ts
const toolTimeout = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
// ...
for (const tc of response.toolCalls) {
  // ...
  result = await Promise.race([
    adapter.executeTool(tc.name, tc.arguments, logger),
    new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Tool "${tc.name}" timed out after ${toolTimeout}ms`)),
        toolTimeout,
      );
    }),
  ]);
```

With (build a name → maxExecutionMs lookup from `tools` once outside the per-turn loop):

```ts
// At top of the runAgent main loop scope, once:
const toolTimeoutOverrides = new Map<string, number>();
for (const td of tools) {
  if (typeof td.maxExecutionMs === "number" && td.maxExecutionMs > 0) {
    toolTimeoutOverrides.set(td.name, td.maxExecutionMs);
  }
}
const baseToolTimeout = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

// ... inside the for-tc-of-response.toolCalls loop, replace `const toolTimeout = …`:
const toolTimeout = toolTimeoutOverrides.get(tc.name) ?? baseToolTimeout;
```

- [ ] **Step 4: Set the override on `wake_on_idle_log`**

In `src/agent/wake-on-idle-log-tool.ts`, change the `definition`:

```ts
const definition: ToolDefinition = {
  name: "wake_on_idle_log",
  description: WAKE_ON_IDLE_LOG_DESCRIPTION,
  maxExecutionMs: WAKE_TIMEOUT_MS_MAX + 10_000, // a small grace over our internal clamp
  parameters: { /* ... unchanged ... */ },
};
```

The 10s grace ensures our internal 240s clamp fires first (returning `reason: "timeout"`), not the agent's outer race.

- [ ] **Step 5: Run tests, verify pass**

Run: `bun test test/agent/`
Expected: all green. The Task 6 tests that use `timeout_ms: 5000` no longer hit the 30s race because they were short anyway; the new behavior covers the spec's 240s ceiling.

- [ ] **Step 6: Commit**

```bash
git add src/models/provider.ts src/agent/agent.ts src/agent/wake-on-idle-log-tool.ts test/agent/tool-timeout-override.test.ts
git commit -m "feat(agent): per-tool maxExecutionMs override for executeTool race (PRI-1864)"
```

---

## Task 7: Wire both tools into `buildSharedTools`

**Files:**
- Modify: `src/agent/shared-tools.ts`
- Test: extend existing `test/agent/` tests by adding a small integration test, OR rely on the per-tool tests.

Goal: every adapter that uses `buildSharedTools` (TUI, CLI, web) now has `watch_logs` and `wake_on_idle_log` in its tool surface.

- [ ] **Step 1: Write failing test**

Create `test/agent/shared-tools-watch.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildSharedTools } from "../../src/agent/shared-tools";
import type { EvidenceLogger } from "../../src/evidence/logger";

function noopLogger(): EvidenceLogger {
  return { logEvent: () => {} } as unknown as EvidenceLogger;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "gauntlet-shared-watch-"));
}

describe("buildSharedTools exposes watch_logs + wake_on_idle_log", () => {
  test("definitions include watch_logs and wake_on_idle_log", () => {
    const shared = buildSharedTools({ cwd: freshDir() });
    const names = shared.definitions().map((d) => d.name);
    expect(names).toContain("watch_logs");
    expect(names).toContain("wake_on_idle_log");
  });

  test("canExecute returns true for both", () => {
    const shared = buildSharedTools({ cwd: freshDir() });
    expect(shared.canExecute("watch_logs")).toBe(true);
    expect(shared.canExecute("wake_on_idle_log")).toBe(true);
  });

  test("execute routes watch_logs and wake_on_idle_log end-to-end", async () => {
    const dir = freshDir();
    const shared = buildSharedTools({ cwd: dir });
    const wlog = await shared.execute(
      "watch_logs",
      { glob: join(dir, "*.log") },
      noopLogger(),
    );
    expect(JSON.parse(wlog.text).watching).toEqual([join(dir, "*.log")]);

    setTimeout(() => writeFileSync(join(dir, "x.log"), "y\n"), 50);
    const wake = await shared.execute(
      "wake_on_idle_log",
      { idle_ms: 60_000, timeout_ms: 5_000, poll_interval_ms: 25 },
      noopLogger(),
    );
    expect(JSON.parse(wake.text).reason).toBe("new_file");
  });

  test("both tools share state — registration in watch_logs is visible to wake_on_idle_log", async () => {
    const shared = buildSharedTools({ cwd: freshDir() });
    await shared.execute("watch_logs", { glob: "/tmp/shared-state-test/*.log" }, noopLogger());
    const wake = await shared.execute(
      "wake_on_idle_log",
      { idle_ms: 60_000, timeout_ms: 100, poll_interval_ms: 25 },
      noopLogger(),
    );
    expect(JSON.parse(wake.text).watching).toEqual(["/tmp/shared-state-test/*.log"]);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `bun test test/agent/shared-tools-watch.test.ts`
Expected: FAIL — both tools missing.

- [ ] **Step 3: Modify `src/agent/shared-tools.ts`**

```ts
import type { ToolDefinition, ToolResult } from "../models/provider";
import type { EvidenceLogger } from "../evidence/logger";
import type { CredentialResolverConfig } from "../config";
import { buildReadTool, type ReadTool } from "../context/read-tool";
import { buildFetchCredentialTool, type FetchCredentialTool } from "../context/credential-tool";
import { buildBashTool, type BashTool } from "./bash-tool";
import { WatchManager } from "./watch-manager";
import { buildWatchLogsTool, type WatchLogsTool } from "./watch-logs-tool";
import { buildWakeOnIdleLogTool, type WakeOnIdleLogTool } from "./wake-on-idle-log-tool";

// ... SharedToolsOptions and SharedTools interfaces unchanged ...

export function buildSharedTools(opts: SharedToolsOptions): SharedTools {
  const readTool: ReadTool | null = opts.contextRoot
    ? buildReadTool(opts.contextRoot)
    : null;
  const credentialTool: FetchCredentialTool | null = buildFetchCredentialTool(
    opts.contextRoot ?? "",
    opts.credentialResolver,
  );
  const bashTool: BashTool = buildBashTool({ cwd: opts.cwd });
  const watchManager = new WatchManager();
  const watchLogsTool: WatchLogsTool = buildWatchLogsTool({ manager: watchManager });
  const wakeTool: WakeOnIdleLogTool = buildWakeOnIdleLogTool({ manager: watchManager });

  const definitions = (): ToolDefinition[] => {
    const defs: ToolDefinition[] = [];
    if (readTool) defs.push(readTool.definition);
    if (credentialTool) defs.push(credentialTool.definition);
    defs.push(bashTool.definition);
    defs.push(watchLogsTool.definition);
    defs.push(wakeTool.definition);
    return defs;
  };

  const canExecute = (name: string): boolean => {
    if (name === "read") return readTool !== null;
    if (name === "fetch_credential") return credentialTool !== null;
    if (name === "bash") return true;
    if (name === "watch_logs") return true;
    if (name === "wake_on_idle_log") return true;
    return false;
  };

  const execute = (
    name: string,
    args: Record<string, unknown>,
    logger: EvidenceLogger,
  ): Promise<ToolResult> | ToolResult => {
    if (name === "read" && readTool) return readTool.execute(args);
    if (name === "fetch_credential" && credentialTool) {
      return credentialTool.execute(args, logger);
    }
    if (name === "bash") return bashTool.execute(args, logger);
    if (name === "watch_logs") return watchLogsTool.execute(args, logger);
    if (name === "wake_on_idle_log") return wakeTool.execute(args, logger);
    throw new Error(`SharedTools: unknown or unmounted tool: ${name}`);
  };

  return { definitions, canExecute, execute };
}
```

- [ ] **Step 4: Run all tests, verify pass**

Run: `bun test test/agent/`
Expected: PASS — all watch-manager / watch-logs / wake-on-idle-log / shared-tools-watch tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/shared-tools.ts test/agent/shared-tools-watch.test.ts
git commit -m "feat(watch): wire watch_logs + wake_on_idle_log into SharedTools (PRI-1864)"
```

---

## Task 8: Empty-end_turn safety net in the agent runner

**Files:**
- Modify: `src/agent/agent.ts` around lines 462-475
- Test: `test/agent/empty-end-turn-safety-net.test.ts`

Today (`src/agent/agent.ts:462-475`):
```ts
} else {
  // Neither tool calls nor text. Re-sending the same prompt would
  // produce the same empty response — break instead of spinning for
  // the rest of MAX_TURNS.
  logger.logEvent("empty_response", { ... });
  return buildResult({ status: "investigate", ... });
}
```

Goal: if `outputTokens < 5` AND no tool calls AND no text — inject a nudge user message and *re-request once*. Only end the run if the *second* response is also empty.

The current code unconditionally returns. We change it to:
1. First empty: log it, inject nudge, do one extra chat() call (not counted as a turn).
2. Second empty: log it as `empty_response_after_nudge`, return investigate.

**Approach:** before adding the safety net, extract the "process one response" dispatch from inside the `while` loop into a local helper `dispatchResponse(response)` returning a discriminated union: `"continue" | { kind: "ended"; result: VetResult } | { kind: "empty-retry-needed" }`. This makes the empty-response retry trivial: the handler returns "needs retry," we call `chat` again with the nudge, and call `dispatchResponse` on the retry response.

Note: `response` is currently declared `const` (agent.ts:284). Change it to `let` so the empty-retry path can rebind it cleanly; or rewrite the inner dispatch as a function taking response as an argument (preferred — no mutation).

- [ ] **Step 1: Write failing test**

```ts
// test/agent/empty-end-turn-safety-net.test.ts
import { describe, test, expect } from "bun:test";
// This test uses a fake LLM client to drive runAgent through the empty-response path.
// Approach: build a minimal fake ProviderClient that returns scripted responses,
// then call the agent's loop directly (via an exported test entrypoint) and assert
// the nudge re-request happens.
//
// We export and test `handleEmptyResponseAfterChat` directly — a small,
// pure function that takes a fake `LLMClient`, a fake `EvidenceLogger`,
// and asserts the nudge + retry behavior.

import { handleEmptyResponseAfterChat } from "../../src/agent/agent";
// ^ exported by the refactor in this task.

describe("empty-end_turn safety net", () => {
  test("first empty response triggers one nudge re-request", async () => {
    let chatCalls = 0;
    const fakeClient = {
      chat: async () => {
        chatCalls++;
        if (chatCalls === 1) {
          // The nudged response — this time the model emits a report_result call
          return {
            stopReason: "tool_use",
            text: "stuck, reporting",
            toolCalls: [
              {
                id: "x",
                name: "report_result",
                arguments: {
                  status: "investigate",
                  summary: "agent went idle",
                  reasoning: "saw nudge after empty turn",
                },
              },
            ],
            thinking: [],
            usage: { inputTokens: 1, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            rawAssistantMessage: { role: "assistant", content: [] },
          };
        }
        throw new Error("should only call chat once for the nudge");
      },
      userMessage: (text: string) => ({ role: "user", content: text }),
      toolResultMessages: () => [],
    };

    const events: { name: string; payload: Record<string, unknown> }[] = [];
    const logger = {
      logEvent: (name: string, payload: Record<string, unknown>) => events.push({ name, payload }),
      logUserMessage: () => {},
      logLlmRequest: () => {},
      logLlmResponse: () => {},
    } as unknown as import("../../src/evidence/logger").EvidenceLogger;

    const out = await handleEmptyResponseAfterChat({
      messages: [],
      systemPrompt: "",
      runId: "test",
      turn: 5,
      tools: [],
      client: fakeClient as unknown as import("../../src/models/provider").LLMClient,
      logger,
    });

    expect(chatCalls).toBe(1);
    expect(out.kind).toBe("recovered");
    expect(events.some((e) => e.name === "empty_response_nudge")).toBe(true);
  });

  test("second empty response ends with investigate", async () => {
    const fakeClient = {
      chat: async () => ({
        stopReason: "end_turn",
        text: "",
        toolCalls: [],
        thinking: [],
        usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        rawAssistantMessage: { role: "assistant", content: [] },
      }),
      userMessage: (text: string) => ({ role: "user", content: text }),
      toolResultMessages: () => [],
    };

    const events: { name: string; payload: Record<string, unknown> }[] = [];
    const logger = {
      logEvent: (name: string, payload: Record<string, unknown>) => events.push({ name, payload }),
      logUserMessage: () => {},
      logLlmRequest: () => {},
      logLlmResponse: () => {},
    } as unknown as import("../../src/evidence/logger").EvidenceLogger;

    const out = await handleEmptyResponseAfterChat({
      messages: [],
      systemPrompt: "",
      runId: "test",
      turn: 5,
      tools: [],
      client: fakeClient as unknown as import("../../src/models/provider").LLMClient,
      logger,
    });

    expect(out.kind).toBe("ended");
    expect(events.some((e) => e.name === "empty_response_after_nudge")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `bun test test/agent/empty-end-turn-safety-net.test.ts`
Expected: FAIL — `handleEmptyResponseAfterChat` not exported.

- [ ] **Step 3: Extract the handler in `src/agent/agent.ts`**

Add this exported function above `runAgent`:

```ts
import type { LLMClient, AgentResponse } from "../models/provider";

export interface EmptyResponseHandlerArgs {
  messages: Parameters<LLMClient["chat"]>[0];
  systemPrompt: string;
  runId: string;
  turn: number;
  tools: ToolDefinition[];
  client: LLMClient;
  logger: EvidenceLogger;
}

export type EmptyResponseOutcome =
  | { kind: "recovered"; response: AgentResponse }
  | { kind: "ended" };

const EMPTY_RESPONSE_NUDGE =
  "<SYSTEM-REMINDER>\n" +
  "You returned no tool calls and no text. Either:\n" +
  "  - Call report_result with a status to end the run, or\n" +
  "  - Take another action (use the tools).\n" +
  "If you intend to wait, prefer wake_on_idle_log over leaving an empty turn.\n" +
  "</SYSTEM-REMINDER>";

export async function handleEmptyResponseAfterChat(
  args: EmptyResponseHandlerArgs,
): Promise<EmptyResponseOutcome> {
  args.logger.logEvent("empty_response_nudge", { turn: args.turn });
  const messagesWithNudge = [
    ...args.messages,
    args.client.userMessage(EMPTY_RESPONSE_NUDGE),
  ];
  const retry = await args.client.chat(
    messagesWithNudge,
    args.tools,
    args.systemPrompt,
    { runId: args.runId },
  );
  const empty = !retry.text && retry.toolCalls.length === 0 && (retry.usage.outputTokens ?? 0) < 5;
  if (empty) {
    args.logger.logEvent("empty_response_after_nudge", { turn: args.turn });
    return { kind: "ended" };
  }
  return { kind: "recovered", response: retry };
}
```

- [ ] **Step 4: Refactor the response-dispatch in the `while` loop**

The current shape (agent.ts ~284-475 simplified):

```ts
while (Date.now() < deadline) {
  // ...
  const response = await client.chat(...);
  // ... usage tracking, logging ...
  if (reportTool present) { return ... }
  if (response.toolCalls.length > 0) { /* run them */ }
  else if (response.text) { /* push assistant turn, continue */ }
  else {
    /* empty — return investigate */
  }
}
```

Extract the dispatch into a local helper inside `runAgent`:

```ts
type DispatchOutcome =
  | { kind: "continue" }
  | { kind: "ended"; result: VetResult }
  | { kind: "empty" };

async function dispatchResponse(response: AgentResponse): Promise<DispatchOutcome> {
  // 1. report_result check (move existing block here, return { kind: "ended", result })
  // 2. toolCalls path (move existing block here, return { kind: "continue" })
  // 3. text-only path (move existing block here, return { kind: "continue" })
  // 4. fully empty — return { kind: "empty" }
}
```

Then the main loop becomes:

```ts
while (Date.now() < deadline) {
  // ... pre-flight checks, logging, request ...
  let response = await client.chat(...);
  let outcome = await dispatchResponse(response);
  if (outcome.kind === "empty") {
    const retry = await handleEmptyResponseAfterChat({
      messages, systemPrompt, runId, turn: turns, tools, client, logger,
    });
    if (retry.kind === "ended") {
      logger.logEvent("empty_response", { turn: turns, stopReason: response.stopReason });
      return buildResult({
        status: "investigate",
        summary: "LLM returned empty content twice, even after a nudge",
        reasoning: `Empty response on turn ${turns} and again after nudge. Likely model self-priming on an empty-prefix pattern.`,
      });
    }
    response = retry.response;
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;
    totalCacheCreation += response.usage.cacheCreationInputTokens ?? 0;
    totalCacheRead += response.usage.cacheReadInputTokens ?? 0;
    outcome = await dispatchResponse(response);
    // If the retry is somehow ended/empty too, just fall out of the loop;
    // budget will catch infinite weirdness. (The retry was already proven
    // non-empty above via handleEmptyResponseAfterChat.)
  }
  if (outcome.kind === "ended") return outcome.result;
  // outcome.kind === "continue"
}
```

This requires `response` to be `let` (currently `const` at the original line 284). Change the declaration.

The exact line-by-line extraction of the report_result / toolCalls / text branches into the helper is a mechanical move — keep the logic identical; only the control-flow shape changes from `if/else if/else` returns to discriminated-union returns.

- [ ] **Step 5: Run all agent tests, verify pass**

Run: `bun test test/agent/`
Expected: PASS — both new safety-net tests + all prior tests (the empty-response path now behaves differently but is still exercised correctly).

- [ ] **Step 6: Commit**

```bash
git add src/agent/agent.ts test/agent/empty-end-turn-safety-net.test.ts
git commit -m "feat(agent): nudge once before ending run on empty LLM response (PRI-1864)"
```

---

## Task 9: HOWTO patch — Codex

**Files:**
- Modify: `/Users/mw/Code/prime/superpowers-evals/coding-agents/codex-context/HOWTO.md`

This task is in the **superpowers-evals** repo. The branch is `matt/pri-1864-watch-logs-wake-on-idle-log` (already created).

The existing file (`/Users/mw/Code/prime/superpowers-evals/coding-agents/codex-context/HOWTO.md`) lines 29-40:

```markdown
## Observing what Codex is doing

Codex writes rollout logs as JSONL files under
`$CODEX_HOME/sessions/rollout-*.jsonl`. Because this run has its own
isolated `CODEX_HOME`, anything in there is from this session. Find the
newest file:

```
ls -t "$CODEX_HOME/sessions"/rollout-*.jsonl | head -1
```

`tail` or `jq` it to see Codex's tool invocations.
```

- [ ] **Step 1: Replace this section** with the patched version

New section (replaces lines 29-40 wholesale — note the path correction from flat to `**`, and the demotion of sleep-poll):

````markdown
## Observing what Codex is doing

Codex writes rollout logs as JSONL files under
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` — one file per
(sub)agent, organized by date. Active subagents append every few
seconds; idle ones stop appending.

The rollout JSONL is **ground truth** for what Codex has done — every
tool call, every reasoning step, every shell invocation lands there.
The screen is a rendering that can lag, scroll off the top, or stay
frozen while subagents do long work. Trust the log over the screen.

## Waiting for Codex to work

When Codex is busy (especially executing multi-step plans that dispatch
subagents), do **not** poll the screen with `sleep`. Instead, register
the rollout glob once after launch, then block-wait:

```
watch_logs(glob="$CODEX_HOME/sessions/**/rollout-*.jsonl")
wake_on_idle_log(idle_ms=60000, timeout_ms=240000)
```

`wake_on_idle_log` blocks one inference turn until:

* **idle**: no log activity for `idle_ms` (60s here) — likely a good
  moment to check in
* **new_file**: a new subagent rollout appears — qualitatively new state
* **timeout**: 240s ceiling (don't go higher; the model context cache
  expires past that)

This costs one turn per ~4 minutes of real time, vs. one turn per 25s
for `sleep`-and-poll. The cost difference compounds over a 30–60 min
long-haul. Use ad-hoc `bash tail -n` *after* waking if you want to see
what changed.
````

- [ ] **Step 2: Verify the file**

Run from the superpowers-evals checkout: `head -50 coding-agents/codex-context/HOWTO.md`
Confirm the new "Waiting for Codex to work" section is present and the old "Find the newest file / tail or jq it" prose is gone.

- [ ] **Step 3: Commit**

```bash
cd /Users/mw/Code/prime/superpowers-evals
git add coding-agents/codex-context/HOWTO.md
git commit -m "docs(codex-howto): teach watch_logs + wake_on_idle_log, demote sleep-poll (PRI-1864)"
```

---

## Task 10: HOWTO patch — Claude Code

**Files:**
- Modify: `/Users/mw/Code/prime/superpowers-evals/coding-agents/claude-context/HOWTO.md`

The existing file already has a good "Observing what Claude is doing" section (lines 35-71). It explains the log is ground truth, says to tail it with `jq`, and warns about screen-lag. We extend rather than replace, adding a "Waiting for Claude to work" subsection that points to the new tools and demotes `sleep`-and-poll. We *also* edit lines 49-56 to remove the implicit suggestion that the agent should poll `read_screen` then check the log — that's now what `wake_on_idle_log` does.

- [ ] **Step 1: Edit lines 49-56**

Replace:

```markdown
**Use the log, not just `read_screen`, when:**

- Two `read_screen` calls in a row return near-identical content.
  Claude is probably running a long tool (subagent dispatch, a build,
  a test command) that produces no parent-screen output. Tail the log
  to see real activity.
- You need to verify a specific tool call or Skill load happened.
- The screen shows a spinner or "running" indicator with no detail.
```

With:

```markdown
**Use the log, not just `read_screen`, when:**

- You need to verify a specific tool call or Skill load happened.
- The screen shows a spinner or "running" indicator with no detail.

For waiting on Claude to make progress, do not poll `read_screen` —
see "Waiting for Claude to work" below.
```

- [ ] **Step 2: Append the new section after the existing "Find the active session file" block** (just before "## Shutdown")

```markdown
## Waiting for Claude to work

When Claude is busy (especially when it dispatches subagents via
`Agent`, or runs a long bash command), do **not** poll the screen with
`sleep`. Register the rollout glob once after launch, then block-wait:

\```
watch_logs(glob="$CLAUDE_CONFIG_DIR/projects/**/*.jsonl")
wake_on_idle_log(idle_ms=60000, timeout_ms=240000)
\```

`wake_on_idle_log` blocks one inference turn until:

* **idle**: no log activity for `idle_ms` (60s here) — likely a good
  moment to check in
* **new_file**: a new session file appears — Claude opened a new
  conversation or a fresh subagent thread
* **timeout**: 240s ceiling (don't go higher; the model context cache
  expires past that)

This costs one turn per ~4 minutes of real time, vs. one turn per 25s
for `sleep`-and-poll. Use ad-hoc `bash tail -n` *after* waking if you
want to see what changed.
```

- [ ] **Step 3: Verify**

Run from the superpowers-evals checkout: `cat coding-agents/claude-context/HOWTO.md`
Confirm: the "Two `read_screen` in a row" bullet is gone; a "Waiting for Claude to work" section exists; the demotion of `sleep`-poll is explicit.

- [ ] **Step 4: Commit**

```bash
cd /Users/mw/Code/prime/superpowers-evals
git add coding-agents/claude-context/HOWTO.md
git commit -m "docs(claude-howto): teach watch_logs + wake_on_idle_log, demote sleep-poll (PRI-1864)"
```

---

## Task 11: Full-suite verification

**Files:** none changed.

- [ ] **Step 1: Run full test suite in gauntlet**

Run from gauntlet/: `bun test`
Expected: All tests pass. (If pre-existing failures exist, they are out of scope for this plan; report them but don't fix them.)

- [ ] **Step 2: Run typecheck**

Run from gauntlet/: `bun run typecheck` (or whatever `package.json` defines — likely `tsc --noEmit`)
Expected: clean.

- [ ] **Step 3: Smoke-build (UI may not be needed but cheap)**

Run from gauntlet/: `bun run build:ui` if defined.
Expected: clean.

- [ ] **Step 4: Sanity-check the two new tools appear in adapter introspection**

Run from gauntlet/:
```bash
bun run src/index.ts show-prompt --adapter tui --target 'echo hi' 2>&1 | grep -E 'watch_logs|wake_on_idle_log'
```
Expected: both tool names appear.

(Adjust the command to match `show-prompt`'s actual flags — see `src/cli/show-prompt.ts` for the real interface.)

- [ ] **Step 5: No commit needed** unless any of the above produces fixes.

---

## Self-review checklist

Before declaring complete:

1. **Spec coverage:**
   - Both tools in SharedTools ✓ (Task 7)
   - Idle / new_file / timeout reasons ✓ (Task 3)
   - Concurrent-call guard ✓ (Task 4)
   - Clamps + invalid-value rejection ✓ (Task 6)
   - Watch-set returned in every result ✓ (Tasks 5, 6)
   - Append (size or mtime), truncation as activity ✓ (Task 2)
   - Glob re-evaluated continuously ✓ (Task 2: scan picks up files appearing later)
   - Missing-dir-at-registration graceful ✓ (Task 2)
   - Empty-end_turn safety net ✓ (Task 8)
   - Both HOWTOs patched with demotion ✓ (Tasks 9, 10)

2. **Placeholder scan:** none.

3. **Type consistency:**
   - `WakeResult.reason` includes `"concurrent_call"` after Task 4.
   - `WatchManager.currentGlobs()` used in `wake_on_idle_log` result.
   - `WaitForWakeOptions.pollIntervalMs` matches across manager and tool.
