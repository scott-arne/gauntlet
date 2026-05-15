# TUI adapter shell-as-session + CLI close simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the TUI adapter in-line with the CLI shell-as-session model (tmux pane hosts an interactive bash with isolated scratch cwd; target is informational; close reaps descendants). In the same change, collapse CLI's three-step close escalation ladder to a single SIGKILL of the pgrp.

**Architecture:** `listDescendants` lifts to `src/runtime/process-tree.ts` so both adapters share it. CLI close() drops the graceful-`exit`-and-SIGHUP layers, keeps descendant reap. TUI start() spawns `bash --norc --noprofile -i` inside the tmux pane via `tmux new-session -c <scratch> bash …`; close() snapshots the pane process's descendants, runs `tmux kill-session`, and SIGKILLs survivors. Both adapters emit a `*_descendants_reaped` event only when reap count > 0.

**Tech Stack:** TypeScript / Bun. Tests use `bun:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-15-tui-adapter-shell-as-session-design.md` (commits `89ad03b`, `133d87a`).

**Linear:** [PRI-1611](https://linear.app/prime-radiant/issue/PRI-1611). Parallel follow-up to PRI-1608.

**Order:** Helper lift first (no behavior change, validates CLI still green). Then CLI close simplification + test rewrite (regression-protected by the surviving tests). Then TUI primary work in three layers: state + start, describeTarget, close. Then orchestrator wiring. Then TUI test rewrite. TDD throughout — write the failing test, then the implementation, then commit.

---

## File structure

```
src/runtime/process-tree.ts                  # T1: new, exports listDescendants
src/adapters/cli/adapter.ts                  # T1 import; T2 close() simplification
src/adapters/tui/adapter.ts                  # T3–T6 (constructor, start, describeTarget, close)
src/runs/orchestrator.ts                     # T7: forward runDir + logger to TUIAdapter

test/runtime/process-tree.test.ts            # T1 (new)
test/adapters/cli-adapter.test.ts            # T2 rewrite (drop ladder tests; add reaped-event)
test/adapters/tui/adapter.test.ts            # T8: unit-test rewrite
test/e2e/tui-nano.test.ts                    # T9
test/e2e/tui-colored-alphabet.test.ts        # T9
```

The Adapter interface itself does not change. `Adapter.close()` already returns Promise<void>; `Adapter.start(target)` already takes a single string.

---

## Task 1: Lift `listDescendants` into a shared module (no behavior change)

The function currently lives in `src/adapters/cli/adapter.ts` (lines 18–43). It will be needed by both adapters, so move it to a shared module before changing any behavior. CLI keeps working with the lifted import.

**Files:**
- Create: `src/runtime/process-tree.ts`
- Modify: `src/adapters/cli/adapter.ts` (drop the inline copy, import from new module)
- Create: `test/runtime/process-tree.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/runtime/process-tree.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { spawn as bunSpawn } from "bun";
import { listDescendants } from "../../src/runtime/process-tree";

describe("listDescendants", () => {
  test("returns direct and transitive children of a root pid", async () => {
    // Parent shell spawns a child sleep. listDescendants(parent.pid) must
    // include the child sleep's pid.
    const parent = bunSpawn(["bash", "-c", "sleep 5 & wait"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    // Give bash a beat to fork the sleep child.
    await new Promise((r) => setTimeout(r, 150));
    try {
      const kids = listDescendants(parent.pid);
      expect(kids.length).toBeGreaterThan(0);
      // At least one descendant should be alive right now.
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
    // Use our own pid — Bun's test harness has no descendant test processes
    // sitting around for us, so the worst-case here is "a few" descendants.
    // We don't assert empty; we assert it doesn't throw and returns a number array.
    const result = listDescendants(process.pid);
    expect(Array.isArray(result)).toBe(true);
    for (const pid of result) {
      expect(Number.isFinite(pid)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/runtime/process-tree.test.ts`

Expected: FAIL — `Cannot find module '../../src/runtime/process-tree'`.

- [ ] **Step 3: Create the new module**

Create `src/runtime/process-tree.ts` with the function lifted verbatim from `src/adapters/cli/adapter.ts:18–43`:

```ts
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
```

- [ ] **Step 4: Run the new test — it should pass**

Run: `bun test test/runtime/process-tree.test.ts`

Expected: PASS (both tests).

- [ ] **Step 5: Switch CLI adapter to use the lifted helper**

In `src/adapters/cli/adapter.ts`:

1. Delete the local `function listDescendants(...)` (lines 18–43).
2. Add `import { listDescendants } from "../../runtime/process-tree";` near the other runtime imports (around line 10).

- [ ] **Step 6: Verify CLI tests still pass**

Run: `bun test test/adapters/cli-adapter.test.ts test/adapters/cli/adapter.test.ts`

Expected: PASS. No behavior change — the function moved, nothing else.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/process-tree.ts test/runtime/process-tree.test.ts src/adapters/cli/adapter.ts
git commit -m "$(cat <<'EOF'
runtime: lift listDescendants to runtime/process-tree (PRI-1611)

Shared helper for adapters that wrap an interactive shell. CLI uses
it today; TUI adopts it in a follow-up commit. Function moved
verbatim — no behavior change.

Co-Authored-By: Penric@1810bf08 (Opus 4.7)
EOF
)"
```

---

## Task 2: Simplify CLI `close()` — drop the escalation ladder

Collapse the three-step ladder to a single SIGKILL of the pgrp, keep the descendant snapshot + reap, replace the `cli_shell_force_killed` event with `cli_shell_descendants_reaped`.

**Files:**
- Modify: `src/adapters/cli/adapter.ts` (close + helpers + constants)
- Modify: `test/adapters/cli-adapter.test.ts` (drop ladder tests; rewrite orphan-reap to check new event)

- [ ] **Step 1: Write the new failing test for the reaped-event**

Replace the `"orphan reap"` test in `test/adapters/cli-adapter.test.ts` (~lines 80–100) with:

```ts
test("orphan reap: backgrounded sleep is gone after close and event fires", async () => {
  const adapter = new CLIAdapter({ contextRoot: undefined, runDir, logger });
  await adapter.start("");
  await new Promise((r) => setTimeout(r, 300));
  await adapter.executeTool(
    "type",
    { text: "sleep 999 & echo PID=$!\n" },
    logger,
  );
  await new Promise((r) => setTimeout(r, 300));
  const out = await adapter.executeTool("read_output", {}, logger);
  const match = out.text.match(/PID=(\d+)/);
  expect(match).not.toBeNull();
  const childPid = Number(match![1]);
  expect(pidStillAlive(childPid)).toBe(true);

  await adapter.close();
  await new Promise((r) => setTimeout(r, 100));
  expect(pidStillAlive(childPid)).toBe(false);

  const jsonl = readRunJsonl(runDir);
  expect(jsonl).toContain("cli_shell_descendants_reaped");
  expect(jsonl).not.toContain("cli_shell_force_killed");
});
```

- [ ] **Step 2: Drop tests that no longer apply**

Delete the following blocks from `test/adapters/cli-adapter.test.ts`:

- The `"graceful exit: \\nexit\\n triggers no SIGHUP or SIGKILL"` test (around lines 69–78). Reason: the new close() unconditionally SIGKILLs the pgrp; there is no graceful-vs-forced distinction to assert.
- The `"half-typed line: close still exits cleanly"` test (around lines 102–112). Reason: same — no `\nexit\n` write happens, no `cli_shell_force_killed` event to *not* find.
- The entire `describe("CLIAdapter — fallback escalation", ...)` block (around lines 115–156). Both `SIGHUP-suffices` and `SIGKILL-fallback` tests go. Reason: the escalation ladder is being removed.

After the deletions the file's section structure is:

```
describe("CLIAdapter — shell session", ...)        // unchanged
describe("CLIAdapter — close cleanup", ...)        // renamed from "close escalation"
  test("orphan reap: ... and event fires", ...)    // rewritten in Step 1
describe("CLIAdapter — prompt-response compatibility", ...) // unchanged
```

Rename the surviving describe block from `"CLIAdapter — close escalation"` to `"CLIAdapter — close cleanup"`.

- [ ] **Step 3: Add a "no event when nothing to reap" test**

Inside the renamed `"CLIAdapter — close cleanup"` block, after the orphan-reap test, add:

```ts
test("no event emitted when there are no descendants to reap", async () => {
  const adapter = new CLIAdapter({ contextRoot: undefined, runDir, logger });
  await adapter.start("");
  // Don't background anything. Close should reap nothing → no event.
  await new Promise((r) => setTimeout(r, 200));
  await adapter.close();
  const jsonl = readRunJsonl(runDir);
  expect(jsonl).not.toContain("cli_shell_descendants_reaped");
  expect(jsonl).not.toContain("cli_shell_force_killed");
});
```

- [ ] **Step 4: Run tests — expect failures referencing the new event name**

Run: `bun test test/adapters/cli-adapter.test.ts`

Expected: at least one FAIL — the orphan-reap test asserts `cli_shell_descendants_reaped` which the code does not yet emit.

- [ ] **Step 5: Rewrite `CLIAdapter.close()`**

In `src/adapters/cli/adapter.ts`, replace the entire `close()` method (lines 169–224) and the helpers `reapDescendants`, `awaitExitWithin`, `logForceKilled`, `cleanupRefs` with:

```ts
async close(): Promise<void> {
  if (!this.proc || this.pgid === null) return;
  const pgid = this.pgid;
  const bashPid = this.proc.pid;
  const descendants = listDescendants(bashPid);

  try { process.kill(-pgid, "SIGKILL"); } catch { /* already dead */ }
  // SIGKILL is synchronous on Unix, but the exited promise resolves
  // after wait4(2) — bound the wait so we don't dangle on a kernel
  // pause. 500ms is generous; the typical case is < 5ms.
  await this.awaitExitWithin(500);

  let reaped = 0;
  for (const pid of descendants) {
    try { process.kill(pid, "SIGKILL"); reaped++; } catch { /* already dead */ }
  }
  if (reaped > 0 && this.logger) {
    this.logger.logEvent("cli_shell_descendants_reaped", {
      pgid,
      descendantCount: descendants.length,
      reapedCount: reaped,
    });
  }

  this.cleanupRefs();
}

private async awaitExitWithin(ms: number): Promise<boolean> {
  if (!this.proc) return true;
  const exited = this.proc.exited;
  const result = await Promise.race([
    exited.then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), ms)),
  ]);
  return result;
}

private cleanupRefs(): void {
  this.proc = null;
  this.pgid = null;
}
```

Also delete the `GRACE_MS` constant (around line 54) — no longer referenced.

- [ ] **Step 6: Run all CLI tests — expect PASS**

Run: `bun test test/adapters/cli-adapter.test.ts test/adapters/cli/adapter.test.ts`

Expected: PASS for every test.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/cli/adapter.ts test/adapters/cli-adapter.test.ts
git commit -m "$(cat <<'EOF'
adapters/cli: collapse close escalation to single SIGKILL (PRI-1611)

The three-step ladder (graceful \nexit\n → SIGHUP → SIGKILL, each
with 500ms wait) was politeness — give bash a chance to exit cleanly
before the hammer. For a test-harness session that runs zero EXIT
traps and discards history, politeness has no value, just ~1s of
close latency per card.

Keeps the part that matters: descendant snapshot + reap, which
catches `&` backgrounded jobs that survive the pgrp signal. Drops
the cli_shell_force_killed event (no escalation step to record)
in favor of cli_shell_descendants_reaped, which fires only when
there were strays.

Co-Authored-By: Penric@1810bf08 (Opus 4.7)
EOF
)"
```

---

## Task 3: TUIAdapter constructor — add `runDir` and `logger`

State plumbing. No start/close changes yet; just expose the new options and store them.

**Files:**
- Modify: `src/adapters/tui/adapter.ts`

- [ ] **Step 1: Add options to the interface and store them**

In `src/adapters/tui/adapter.ts`, replace the `TUIAdapterOptions` interface (around line 45) with:

```ts
export interface TUIAdapterOptions {
  contextRoot?: string;
  /**
   * Per-run directory; adapter creates `<runDir>/scratch` as bash cwd.
   * Required at start(); optional only so the registry's
   * tool-introspection construction (which never starts a session) still
   * works. In production, always set.
   */
  runDir?: string;
  /**
   * Logger used by the adapter to emit cleanup events
   * (`tui_session_descendants_reaped`). Optional for the same registry
   * reason.
   */
  logger?: EvidenceLogger;
  credentialResolver?: CredentialResolverConfig;
  /** Override the capture parser (differential testing, future ghostty
   *  selection). Defaults to xterm. */
  captureParser?: CaptureParser;
}
```

In the `TUIAdapter` class body, add two private fields next to the existing ones (around line 60):

```ts
  private runDir: string | undefined;
  private logger: EvidenceLogger | undefined;
  private bashPid: number | null = null;
```

In the constructor body (around line 62), after the existing assignments, add:

```ts
    this.runDir = options?.runDir;
    this.logger = options?.logger;
```

- [ ] **Step 2: Run existing tests to confirm no regression**

Run: `bun test test/adapters/tui/adapter.test.ts`

Expected: PASS — none of the existing tests touch the new options yet.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/tui/adapter.ts
git commit -m "$(cat <<'EOF'
adapters/tui: add runDir + logger options (PRI-1611)

Plumbing-only commit. Mirrors CLIAdapter's options surface so the
orchestrator can pass the per-run directory and evidence logger
in. start() and close() pick them up in follow-up commits.

Co-Authored-By: Penric@1810bf08 (Opus 4.7)
EOF
)"
```

---

## Task 4: TUIAdapter `start()` — spawn bash inside the tmux pane

The pane process is now `bash`, not the target. Target string is captured for `describeTarget` to surface, but not executed.

**Files:**
- Modify: `src/adapters/tui/adapter.ts`
- Modify: `test/adapters/tui/adapter.test.ts` (one test up front, the rest in T8)

- [ ] **Step 1: Add the new module-level imports**

At the top of `src/adapters/tui/adapter.ts`, add (after the existing imports):

```ts
import { mkdirSync } from "fs";
import { join } from "path";
import { listDescendants } from "../../runtime/process-tree";
```

- [ ] **Step 2: Write the first failing TUI start() test**

In `test/adapters/tui/adapter.test.ts`, inside the `describe.skipIf(!tmuxAvailable)("TUIAdapter", ...)` block, at the top, before existing tests, add:

```ts
test("start() requires runDir", async () => {
  adapter = new TUIAdapter();
  await expect(adapter.start("anything")).rejects.toThrow(/runDir/);
});

test("start() creates <runDir>/scratch and runs bash in it", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "tui-start-"));
  try {
    adapter = new TUIAdapter({ runDir });
    await adapter.start("informational");
    await new Promise((r) => setTimeout(r, 300));
    await adapter.type("pwd\n");
    await new Promise((r) => setTimeout(r, 300));
    const screen = await adapter.readScreen();
    expect(screen).toContain(join(runDir, "scratch"));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
```

(`mkdtempSync`, `rmSync`, `tmpdir`, `join` are already imported at the top of the file — no import changes needed.)

- [ ] **Step 3: Run — expect FAIL**

Run: `bun test test/adapters/tui/adapter.test.ts -t "start"`

Expected: FAIL. The current start() runs the target directly, so `pwd` would be typed into a program that doesn't understand it.

- [ ] **Step 4: Replace `start()`**

In `src/adapters/tui/adapter.ts`, replace the existing `start()` (around lines 78–99) with:

```ts
async start(_target: string): Promise<void> {
  if (!this.runDir) {
    throw new Error("TUIAdapter: runDir is required to start a session");
  }
  const id = `gauntlet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  this._sessionName = id;
  const scratch = join(this.runDir, "scratch");
  mkdirSync(scratch, { recursive: true });

  const create = spawnSync([
    "tmux", "new-session", "-d", "-s", id,
    "-x", String(TUI_GRID.width),
    "-y", String(TUI_GRID.height),
    "-c", scratch,
    "bash", "--norc", "--noprofile", "-i",
  ]);
  if (create.exitCode !== 0) {
    throw new Error(
      `Failed to start tmux session: ${new TextDecoder().decode(create.stderr)}`,
    );
  }

  const pane = spawnSync(["tmux", "list-panes", "-t", id, "-F", "#{pane_pid}"]);
  if (pane.exitCode !== 0) {
    throw new Error(
      `Failed to read pane pid: ${new TextDecoder().decode(pane.stderr)}`,
    );
  }
  const pid = Number(new TextDecoder().decode(pane.stdout).trim());
  if (!Number.isFinite(pid)) {
    throw new Error(
      `Unparseable pane pid: ${new TextDecoder().decode(pane.stdout)}`,
    );
  }
  this.bashPid = pid;
}
```

The `_target` parameter stays in the signature (Adapter interface contract) but is unused inside start.

- [ ] **Step 5: Run — expect PASS for the new tests**

Run: `bun test test/adapters/tui/adapter.test.ts -t "start"`

Expected: PASS for both new tests. The pre-existing tests in this file will be broken (they passed targets to start expecting direct execution) — leave them broken for now; T8 rewrites them as a group.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/tui/adapter.ts test/adapters/tui/adapter.test.ts
git commit -m "$(cat <<'EOF'
adapters/tui: start() spawns bash in tmux pane with scratch cwd (PRI-1611)

The pane process is now bash, not the target. Target string becomes
informational, surfaced via describeTarget (next commit). Scratch
dir created under runDir; bash starts there. pane_pid captured for
close-time descendant snapshot.

Pre-existing TUI unit tests that pass real targets to start() are
broken by this commit; they are rewritten as a group in T8.

Co-Authored-By: Penric@1810bf08 (Opus 4.7)
EOF
)"
```

---

## Task 5: TUIAdapter `describeTarget` — shell wording

**Files:**
- Modify: `src/adapters/tui/adapter.ts`
- Modify: `test/adapters/tui/adapter.test.ts`

- [ ] **Step 1: Update the describeTarget test**

Locate the `describe("TUIAdapter describeTarget", ...)` block in `test/adapters/tui/adapter.test.ts` (around lines 147–155) and replace it with:

```ts
describe("TUIAdapter describeTarget", () => {
  test("frames the agent as inside a bash shell in a tmux pane", () => {
    const adapter = new TUIAdapter();
    const msg = adapter.describeTarget("nano /tmp/foo.txt");
    expect(msg).toContain("bash");
    expect(msg).toContain("nano /tmp/foo.txt");
    expect(msg.toLowerCase()).toContain("exit");
  });

  test("omits the target sentence when target is empty", () => {
    const adapter = new TUIAdapter();
    const msg = adapter.describeTarget("");
    expect(msg).toContain("bash");
    expect(msg).not.toMatch(/command you are exercising/i);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test test/adapters/tui/adapter.test.ts -t "describeTarget"`

Expected: FAIL — current describeTarget says "A terminal application is already running" and contains no "bash".

- [ ] **Step 3: Replace `describeTarget`**

In `src/adapters/tui/adapter.ts`, replace `describeTarget` (around lines 153–159) with:

```ts
describeTarget(target: string): string {
  const base =
    `You are at an interactive bash shell rendered inside a tmux pane ` +
    `(${TUI_GRID.width}×${TUI_GRID.height}). Use \`type\` and \`press\` to ` +
    `issue shell commands and answer any prompts. The shell is your ` +
    `durable session — many commands can run through it during the run. ` +
    `When you are finished, type \`exit\` to close the shell cleanly.`;
  if (!target) return base;
  return `${base} The command you are exercising is \`${target}\`.`;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test test/adapters/tui/adapter.test.ts -t "describeTarget"`

Expected: PASS for both tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/tui/adapter.ts test/adapters/tui/adapter.test.ts
git commit -m "$(cat <<'EOF'
adapters/tui: describeTarget frames the agent in a bash shell (PRI-1611)

Mirrors CLIAdapter's wording. Tells the agent it's at a bash prompt
inside a 120x40 tmux pane, that type/press drive shell commands, and
that the target is the command to exercise (typed in, not auto-run).

Co-Authored-By: Penric@1810bf08 (Opus 4.7)
EOF
)"
```

---

## Task 6: TUIAdapter `close()` — descendant snapshot + reap

**Files:**
- Modify: `src/adapters/tui/adapter.ts`
- Modify: `test/adapters/tui/adapter.test.ts`

- [ ] **Step 1: Write the failing descendant-reap test**

In `test/adapters/tui/adapter.test.ts`, inside the `describe.skipIf(!tmuxAvailable)("TUIAdapter", ...)` block, add:

```ts
test("close reaps backgrounded descendants and emits an event", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "tui-close-"));
  const logDir = mkdtempSync(join(tmpdir(), "tui-close-log-"));
  const logger = new EvidenceLogger(logDir);
  adapter = new TUIAdapter({ runDir, logger });
  try {
    await adapter.start("informational");
    await new Promise((r) => setTimeout(r, 300));
    await adapter.type("sleep 999 & echo PID=$!\n");
    await new Promise((r) => setTimeout(r, 400));
    const screen = await adapter.readScreen();
    const match = screen.match(/PID=(\d+)/);
    expect(match).not.toBeNull();
    const sleepPid = Number(match![1]);
    // It's alive right now.
    expect(() => process.kill(sleepPid, 0)).not.toThrow();

    await adapter.close();
    adapter = null;
    await new Promise((r) => setTimeout(r, 150));

    // Reaped.
    expect(() => process.kill(sleepPid, 0)).toThrow();

    // Event logged.
    const jsonl = readFileSync(join(logDir, "run.jsonl"), "utf-8");
    expect(jsonl).toContain("tui_session_descendants_reaped");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("close emits no event when there are no descendants to reap", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "tui-close-clean-"));
  const logDir = mkdtempSync(join(tmpdir(), "tui-close-clean-log-"));
  const logger = new EvidenceLogger(logDir);
  adapter = new TUIAdapter({ runDir, logger });
  try {
    await adapter.start("informational");
    await new Promise((r) => setTimeout(r, 200));
    await adapter.close();
    adapter = null;
    const jsonl = (() => {
      try { return readFileSync(join(logDir, "run.jsonl"), "utf-8"); }
      catch { return ""; }
    })();
    expect(jsonl).not.toContain("tui_session_descendants_reaped");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});
```

(`readFileSync` is already imported in this file from the existing capture-files test.)

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test test/adapters/tui/adapter.test.ts -t "close"`

Expected: FAIL — current close() doesn't reap descendants or emit any event.

- [ ] **Step 3: Replace `close()`**

In `src/adapters/tui/adapter.ts`, replace `close()` (around lines 165–174) with:

```ts
async close(): Promise<void> {
  if (!this._sessionName) return;
  const sessionName = this._sessionName;
  const descendants = this.bashPid !== null
    ? listDescendants(this.bashPid)
    : [];

  try {
    spawnSync(["tmux", "kill-session", "-t", sessionName]);
  } catch {
    // session may already be dead
  }

  let reaped = 0;
  for (const pid of descendants) {
    try { process.kill(pid, "SIGKILL"); reaped++; } catch { /* already dead */ }
  }
  if (reaped > 0 && this.logger) {
    this.logger.logEvent("tui_session_descendants_reaped", {
      sessionName,
      descendantCount: descendants.length,
      reapedCount: reaped,
    });
  }

  this._sessionName = null;
  this.bashPid = null;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test test/adapters/tui/adapter.test.ts -t "close"`

Expected: PASS for both new tests. The pre-existing `"close kills the tmux session"` test should also still pass — `tmux kill-session` is still called.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/tui/adapter.ts test/adapters/tui/adapter.test.ts
git commit -m "$(cat <<'EOF'
adapters/tui: close() reaps bash descendants (PRI-1611)

Snapshots descendants of the pane's bash before issuing tmux
kill-session, then SIGKILLs the snapshot. Catches backgrounded `&`
jobs which inherit their own pgrp under interactive job control
and would otherwise orphan to init when the tmux session dies.

Emits tui_session_descendants_reaped only when reapedCount > 0.

Co-Authored-By: Penric@1810bf08 (Opus 4.7)
EOF
)"
```

---

## Task 7: Orchestrator — forward `runDir` and `logger` to TUIAdapter

**Files:**
- Modify: `src/runs/orchestrator.ts`

- [ ] **Step 1: Update the construction call**

In `src/runs/orchestrator.ts`, change the TUI case in `buildDefaultAdapter` (around line 161) from:

```ts
return new TUIAdapter({ contextRoot, credentialResolver });
```

to:

```ts
return new TUIAdapter({ contextRoot, runDir, logger, credentialResolver });
```

(`runDir` and `logger` are already in scope — both are parameters to `buildDefaultAdapter` and `outDir` is passed in as `runDir` from `executeRunCore`.)

- [ ] **Step 2: Run any tests that exercise the orchestrator**

Run: `bun test test/runs/`

Expected: PASS (no test should care about adapter construction args directly; this is a wiring-only change).

- [ ] **Step 3: Commit**

```bash
git add src/runs/orchestrator.ts
git commit -m "$(cat <<'EOF'
runs/orchestrator: pass runDir + logger to TUIAdapter (PRI-1611)

The TUI adapter now needs runDir to set up its scratch cwd, and a
logger to emit close-time descendant-reap events. outDir is already
in scope and passed to CLIAdapter the same way.

Co-Authored-By: Penric@1810bf08 (Opus 4.7)
EOF
)"
```

---

## Task 8: Rewrite TUIAdapter unit tests to match shell-as-session model

The existing tests pass real commands as the target to `start()` and expect them to run as the pane process. Under the new model, `start()` ignores the target and the agent types commands into bash. Rewrite the pre-existing tests as a group; the new tests added in T4/T5/T6 stay as written.

**Files:**
- Modify: `test/adapters/tui/adapter.test.ts`

- [ ] **Step 1: Add a `beforeEach` to allocate a runDir**

At the top of the `describe.skipIf(!tmuxAvailable)("TUIAdapter", ...)` block (where `let adapter: TUIAdapter | null = null;` lives), add a shared runDir for the tests that don't allocate their own:

```ts
let adapter: TUIAdapter | null = null;
let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "tui-unit-"));
});

afterEach(async () => {
  if (adapter) {
    try {
      await adapter.close();
    } catch {
      // session may already be dead
    }
  }
  adapter = null;
  rmSync(runDir, { recursive: true, force: true });
});
```

(Import `beforeEach` from `bun:test` at the top of the file; it isn't currently imported.)

- [ ] **Step 2: Rewrite `"starts process in tmux and reads output"`**

Replace the existing test body (around lines 31–37) with:

```ts
test("starts a bash session in tmux and runs a typed command", async () => {
  adapter = new TUIAdapter({ runDir });
  await adapter.start("informational");
  await new Promise((r) => setTimeout(r, 300));
  await adapter.type("echo hello from tmux\n");
  await new Promise((r) => setTimeout(r, 300));
  const screen = await adapter.readScreen();
  expect(screen).toContain("hello from tmux");
});
```

- [ ] **Step 3: Rewrite `"sends keystrokes via tmux"`**

Replace (around lines 39–48) with:

```ts
test("sends keystrokes via tmux: launches bc and computes", async () => {
  adapter = new TUIAdapter({ runDir });
  await adapter.start("bc");
  await new Promise((r) => setTimeout(r, 300));
  await adapter.type("bc -q\n");
  await new Promise((r) => setTimeout(r, 300));
  await adapter.type("2+3");
  await adapter.press("Enter");
  await new Promise((r) => setTimeout(r, 300));
  const screen = await adapter.readScreen();
  expect(screen).toContain("5");
});
```

- [ ] **Step 4: Rewrite `"close kills the tmux session"`**

Replace (around lines 50–58) with:

```ts
test("close kills the tmux session", async () => {
  adapter = new TUIAdapter({ runDir });
  await adapter.start("informational");
  const sessionName = adapter.sessionName;
  await adapter.close();
  const result = Bun.spawnSync(["tmux", "has-session", "-t", sessionName]);
  expect(result.exitCode).not.toBe(0);
  adapter = null;
});
```

- [ ] **Step 5: Rewrite `"executeTool dispatches correctly and returns expected results"`**

Replace (around lines 60–88) with:

```ts
test("executeTool dispatches correctly and returns expected results", async () => {
  adapter = new TUIAdapter({ runDir });
  const logDir = mkdtempSync(join(tmpdir(), "gauntlet-tui-exec-"));
  const innerLogger = new EvidenceLogger(logDir);

  await adapter.start("bc");
  await new Promise((r) => setTimeout(r, 300));
  await adapter.executeTool("type", { text: "bc -q\n" }, innerLogger);
  await new Promise((r) => setTimeout(r, 300));

  const typeResult = await adapter.executeTool("type", { text: "4*5" }, innerLogger);
  expect(typeResult.text).toBe("typed");

  const pressResult = await adapter.executeTool("press", { key: "Enter" }, innerLogger);
  expect(pressResult.text).toBe("pressed");

  await new Promise((r) => setTimeout(r, 300));

  const result = await adapter.executeTool("read_screen", {}, innerLogger);
  expect(result.text).toContain("20");

  // run.jsonl written by the adapter alone (without the agent) should
  // contain zero tool_call rows. tui_capture is allowed.
  const logPath = join(logDir, "run.jsonl");
  const logExists = (() => { try { readFileSync(logPath); return true; } catch { return false; } })();
  if (logExists) {
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).not.toContain('"type":"tool_call"');
  }
});
```

- [ ] **Step 6: Rewrite `"read_screen writes capture files and returns capturePath"`**

Replace the body (around lines 90–118) with:

```ts
test("read_screen writes capture files and returns capturePath", async () => {
  adapter = new TUIAdapter({ runDir });
  const logDir = mkdtempSync(join(tmpdir(), "gauntlet-tui-cap-"));
  const innerLogger = new EvidenceLogger(logDir);

  await adapter.start("informational");
  await new Promise((r) => setTimeout(r, 300));
  await adapter.type("printf hello\n");
  await new Promise((r) => setTimeout(r, 300));

  const result = await adapter.executeTool("read_screen", {}, innerLogger);
  expect((result as { capturePath?: string }).capturePath).toBe("captures/000.ansi");
  expect(result.text).toContain("hello");

  expect(readFileSync(join(logDir, "captures/000.ansi"), "utf-8")).toContain("hello");
  const parsed = JSON.parse(readFileSync(join(logDir, "captures/000.json"), "utf-8"));
  expect(parsed.cols).toBe(120);
  expect(parsed.rows).toBe(40);
  expect(Array.isArray(parsed.cells)).toBe(true);

  const result2 = await adapter.executeTool("read_screen", {}, innerLogger);
  expect((result2 as { capturePath?: string }).capturePath).toBe("captures/001.ansi");
  expect(innerLogger.captures).toEqual(["captures/000.ansi", "captures/001.ansi"]);

  const logContent = readFileSync(join(logDir, "run.jsonl"), "utf-8");
  expect(logContent).toContain('"name":"tui_capture"');
});
```

- [ ] **Step 7: Rewrite `"readScreen preserves ANSI escape sequences"`**

Replace the body (around lines 120–135) with:

```ts
test("readScreen preserves ANSI escape sequences", async () => {
  adapter = new TUIAdapter({ runDir });
  await adapter.start("informational");
  await new Promise((r) => setTimeout(r, 300));
  // Print a red "X" and a green "Y" through bash.
  await adapter.type(`printf '\\033[31mX\\033[0m\\033[32mY\\033[0m\\n'\n`);
  await new Promise((r) => setTimeout(r, 300));
  const screen = await adapter.readScreen();
  expect(screen).toContain("X");
  expect(screen).toContain("Y");
  expect(screen).toMatch(/\x1b\[[0-9;]*31/); // red fg somewhere
  expect(screen).toMatch(/\x1b\[[0-9;]*32/); // green fg somewhere
});
```

- [ ] **Step 8: The `"exposes tool definitions for the agent"` test is unchanged**

This test constructs `new TUIAdapter()` without start() — it works as-is under the new constructor because `runDir` is only required at `start()`. Leave it alone.

- [ ] **Step 9: Run the whole TUI unit test file**

Run: `bun test test/adapters/tui/adapter.test.ts`

Expected: PASS for every test.

- [ ] **Step 10: Commit**

```bash
git add test/adapters/tui/adapter.test.ts
git commit -m "$(cat <<'EOF'
test/adapters/tui: rewrite tests for shell-as-session model (PRI-1611)

start() no longer runs the target directly — it spawns bash in the
pane. Tests now allocate a runDir, start the adapter with an
informational target string, and drive the actual commands via
type() / executeTool("type", ...). Mirrors the f91c425 diff CLI
tests went through.

Co-Authored-By: Penric@1810bf08 (Opus 4.7)
EOF
)"
```

---

## Task 9: Update TUI e2e tests

The two e2e tests (`tui-nano`, `tui-colored-alphabet`) drive the real agent loop with scripted client responses. They need `runDir` plumbed in and a "type the launch command" step prepended to each scripted sequence.

**Files:**
- Modify: `test/e2e/tui-nano.test.ts`
- Modify: `test/e2e/tui-colored-alphabet.test.ts`

- [ ] **Step 1: Update `tui-nano.test.ts` — "pass" case**

In the first test (`"pass: user can open, type, and save in nano"`, around lines 51–82), make these changes:

1. Replace `adapter = new TUIAdapter();` (line 53) with:
   ```ts
   adapter = new TUIAdapter({ runDir: logDir });
   ```
   (`logDir` is already allocated immediately after.)

2. Prepend a "launch nano via shell" step at the start of the `steps` array. The new steps array becomes:

   ```ts
   const steps: AgentResponse[] = [
     step("call_0", "type", { text: `nano ${tempFile}\n` }),
     step("call_1", "read_screen", {}),
     step("call_2", "type", { text: "Hello from gauntlet!" }),
     step("call_3", "read_screen", {}),
     step("call_4", "press", { key: "Ctrl+O" }),
     step("call_5", "read_screen", {}),
     step("call_6", "press", { key: "Enter" }),
     step("call_7", "read_screen", {}),
     report(
       "pass",
       "nano opens, accepts typed text, and saves files",
       "Opened file with initial content, typed text, used Ctrl+O to save, confirmed filename"
     ),
   ];
   ```

3. Change `await adapter.start(\`nano ${tempFile}\`);` (line 77) to:
   ```ts
   await adapter.start(`nano ${tempFile}`);
   ```
   (No change — target string is fine as the informational value; the agent uses it via the prepended type step.)

4. Increase the test timeout from `15_000` to `30_000` to absorb the extra round trip plus the 500ms scripted-client step delay (call_0 added; otherwise budget stays the same).

- [ ] **Step 2: Update `tui-nano.test.ts` — "fail" case**

In the second test (`"fail: nano has no tabs"`, around lines 84–109):

1. Replace `adapter = new TUIAdapter();` with `adapter = new TUIAdapter({ runDir: logDir });`.
2. Prepend the launch step:
   ```ts
   const steps: AgentResponse[] = [
     step("call_0", "type", { text: `nano ${tempFile}\n` }),
     step("call_1", "read_screen", {}),
     report(
       "fail",
       "nano does not support tabbed editing",
       "The screen shows a single file view with no tab bar or tab switching interface"
     ),
   ];
   ```
3. Bump test timeout to `30_000`.

- [ ] **Step 3: Run nano e2e — expect PASS**

Run: `bun test test/e2e/tui-nano.test.ts`

Expected: PASS for both cases. (Skipped on machines without tmux + nano.)

- [ ] **Step 4: Update `tui-colored-alphabet.test.ts`**

In the single test (around lines 42–112):

1. Replace `adapter = new TUIAdapter();` (line 44) with `adapter = new TUIAdapter({ runDir: logDir });`.
2. Prepend a launch step. The fixture path is computed inside the test (line 58); we need that path available before constructing `steps`, so reorder: move the `fixturePath` declaration above the `steps` array.
3. New steps:
   ```ts
   const steps: AgentResponse[] = [
     step("call_0", "type", { text: `sh ${fixturePath}\n` }),
     step("call_1", "read_screen", {}),
     report(
       "pass",
       "agent read the screen",
       "Read ANSI-rendered letters and verified the color mapping",
     ),
   ];
   ```
4. Bump test timeout from `15_000` to `30_000`.

- [ ] **Step 5: Run colored-alphabet e2e — expect PASS**

Run: `bun test test/e2e/tui-colored-alphabet.test.ts`

Expected: PASS.

- [ ] **Step 6: Run the full TUI test set together**

Run: `bun test test/adapters/tui/ test/e2e/tui-*.test.ts`

Expected: PASS for every test.

- [ ] **Step 7: Commit**

```bash
git add test/e2e/tui-nano.test.ts test/e2e/tui-colored-alphabet.test.ts
git commit -m "$(cat <<'EOF'
test/e2e/tui: thread runDir + prepend launch step (PRI-1611)

The TUI adapter no longer runs the target directly. Scripted client
responses gain a leading `type("$target\\n")` step so the agent's
first action is to launch the target inside the pane's bash shell,
matching the shell-as-session model.

Bumps test timeouts to 30s to absorb the extra scripted-client tick.

Co-Authored-By: Penric@1810bf08 (Opus 4.7)
EOF
)"
```

---

## Task 10: Final regression sweep

- [ ] **Step 1: Run the full test suite**

Run: `bun test`

Expected: PASS. Investigate any failures.

- [ ] **Step 2: Run typecheck**

Run: `bun run check` (or whichever typecheck script the repo uses — `bun tsc --noEmit` if no script).

Expected: zero errors.

- [ ] **Step 3: Confirm no orphan references to removed symbols**

Run: `grep -rn "cli_shell_force_killed\|GRACE_MS\|reapDescendants\|logForceKilled" src/ test/`

Expected: zero matches. If any survive, delete them (likely a leftover comment or import).

- [ ] **Step 4: Move ticket to In Review**

Use Linear MCP to move PRI-1611 to **In Review** status and post a reflective comment (per linear-ticket-lifecycle skill). The comment should cover what went smoothly, what was tricky, how you felt, and any risk flags worth a reviewer's attention.

---

## Self-review

**Spec coverage:**
- Module shape (T1 lift, T7 wiring) ✓
- TUIAdapter constructor (T3) ✓
- start() (T4) ✓
- describeTarget (T5) ✓
- close() (T6) ✓
- Orchestrator wiring (T7) ✓
- CLI close() simplification (T2) ✓
- Unit tests (T8) ✓
- e2e tests (T9) ✓
- CLI test keep/drop/add list (T2 Steps 1–3) ✓
- Out-of-scope items (run-tui.sh, escalation ladder) acknowledged in commit messages

**Placeholder scan:** no TBD, no "implement later", every code step contains the actual code.

**Type consistency:** `bashPid: number | null`, `runDir: string | undefined`, `logger: EvidenceLogger | undefined` consistent across T3/T4/T6. Event names: `cli_shell_descendants_reaped` (T2), `tui_session_descendants_reaped` (T6) — both lowercase snake_case, both emitted with `{ descendantCount, reapedCount }` payload (CLI also has `pgid`, TUI also has `sessionName`).
