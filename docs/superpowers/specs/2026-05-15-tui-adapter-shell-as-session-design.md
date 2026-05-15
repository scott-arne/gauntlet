# TUI adapter — shell-as-session model (+ CLI close simplification)

**Linear:** PRI-1611
**Author:** Penric@1810bf08 (Opus 4.7)
**Parallel to:** PRI-1608 (CLI adapter shell-as-session)

---

## Problem

The CLI adapter now spawns an interactive `bash` at `start()` and treats `--target` as informational; the agent types the target as a command into that shell (PRI-1608, commit `f91c425`). The TUI adapter is still on the older model: `start(target)` launches the target program *directly* as the tmux pane process. Two follow-on problems:

1. **Asymmetry.** Fixtures and story authors learn two different mental models — CLI's "you're at a shell, type commands" vs. TUI's "your program is already running." When a project supports both adapters against the same target (the TODO fixture does), the cards diverge mechanically.
2. **No scratch isolation in the adapter.** CLI now owns `runDir/scratch` as the shell's cwd. TUI relies on fixture-side launchers (e.g. `examples/todo/run-tui.sh`) to set up isolated working dirs. The adapter has no hand in it, so the orchestrator can't depend on it.

A smaller, secondary concern: `close()` today is a single `tmux kill-session`. That terminates the pane process group, but interactive bash inside the pane puts each backgrounded `&` job in its own pgrp — those orphan out to `init` when the session dies. We have no descendant reap.

Separately, in the days since PRI-1608 landed, CLI's `close()` has grown a three-step escalation ladder — `\nexit\n` → SIGHUP pgrp → SIGKILL pgrp, each with a 500ms wait — that earns its keep only if a graceful bash exit matters for the test session. It doesn't (no EXIT traps, no history that survives the run). The ladder costs ~1s of close latency on every card and the events it emits (`cli_shell_force_killed`) have no consumer.

## Decision

**TUI (primary):** bring the TUI adapter in-line with the CLI shell-as-session model, adapted for the tmux pane shape:

- The pane hosts an interactive `bash --norc --noprofile -i`, sized to the 120×40 grid, with cwd = `runDir/scratch`.
- The `target` argument to `start()` is informational only — surfaced in `describeTarget` so the agent's system prompt names the command it should type.
- `close()` snapshots bash's descendant pids before issuing `tmux kill-session`, then SIGKILLs the snapshot to reap any orphaned backgrounded jobs.

`read_output` does **not** appear on the TUI side. `read_screen` already plays the role of "what's currently visible" and is retained unchanged.

**CLI (in the same change):** collapse the close escalation ladder to a single SIGKILL of the pgrp. Keep the descendant snapshot + reap (Tree 2) — that's the part actually preventing leaks. Drop the graceful `\nexit\n` attempt, the SIGHUP step, and the `cli_shell_force_killed` event. Both adapters now share the same close shape:

```
snapshot descendants → kill the session (SIGKILL pgrp or tmux kill-session) → SIGKILL descendants → log if reaped > 0
```

### Why drop the graceful-exit escalation

CLI's ladder was added for *politeness* — give bash a chance to exit cleanly before we hammer it. For a test harness session, that politeness has no value: nothing depends on bash flushing history or running EXIT traps. The 1s of wait per close adds up across a 50-card matrix run. SIGKILL is the right default for a session whose only purpose was to host this test.

The descendant walk stays because the failure it prevents — backgrounded `&` jobs surviving the pgrp signal — is a real leak that hurts CI environments. That's the part the user actually asked us to protect.

## Design

### Module shape

```
src/runtime/process-tree.ts        (new, ~30 LOC) — exports listDescendants(root: number)
src/adapters/cli/adapter.ts        — import listDescendants; collapse close() ladder
src/adapters/tui/adapter.ts        — import listDescendants; restructure start/close
src/runs/orchestrator.ts           — forward runDir + logger to TUIAdapter
```

`listDescendants` is lifted from `cli/adapter.ts` verbatim. Two callers today, room for more (any future adapter that wraps an interactive shell will want it).

### TUIAdapter constructor

```ts
export interface TUIAdapterOptions {
  contextRoot?: string;
  /** Per-run directory; adapter creates `<runDir>/scratch` as bash cwd.
   *  Required to start; optional only for the registry's tool-introspection
   *  construction path, identical to CLIAdapter's contract. */
  runDir?: string;
  /** Logger for the `tui_session_descendants_reaped` event. Optional for the
   *  same registry reason. */
  logger?: EvidenceLogger;
  credentialResolver?: CredentialResolverConfig;
  captureParser?: CaptureParser;
}
```

State additions:
- `private runDir: string | undefined`
- `private logger: EvidenceLogger | undefined`
- `private bashPid: number | null` — queried via `tmux list-panes` right after new-session

### start(_target)

```ts
async start(_target: string): Promise<void> {
  if (!this.runDir) throw new Error("TUIAdapter: runDir is required to start a session");
  const id = `gauntlet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  this._sessionName = id;
  const scratch = join(this.runDir, "scratch");
  mkdirSync(scratch, { recursive: true });

  const create = spawnSync([
    "tmux", "new-session", "-d", "-s", id,
    "-x", String(TUI_GRID.width), "-y", String(TUI_GRID.height),
    "-c", scratch,
    "bash", "--norc", "--noprofile", "-i",
  ]);
  if (create.exitCode !== 0) {
    throw new Error(`Failed to start tmux session: ${new TextDecoder().decode(create.stderr)}`);
  }

  const pane = spawnSync([
    "tmux", "list-panes", "-t", id, "-F", "#{pane_pid}",
  ]);
  if (pane.exitCode !== 0) {
    throw new Error(`Failed to read pane pid: ${new TextDecoder().decode(pane.stderr)}`);
  }
  const pid = Number(new TextDecoder().decode(pane.stdout).trim());
  if (!Number.isFinite(pid)) {
    throw new Error(`Unparseable pane pid: ${new TextDecoder().decode(pane.stdout)}`);
  }
  this.bashPid = pid;
}
```

The `_target` parameter is retained in the signature (Adapter interface) but not used by start itself — it's surfaced in `describeTarget`.

### describeTarget

```ts
describeTarget(target: string): string {
  const base =
    `You are at an interactive bash shell rendered inside a tmux pane ` +
    `(${TUI_GRID.width}×${TUI_GRID.height}). Use \`type\` and \`press\` to ` +
    `issue shell commands and answer any prompts. The shell is your durable ` +
    `session — many commands can run through it during the run. When you ` +
    `are finished, type \`exit\` to close the shell cleanly.`;
  if (!target) return base;
  return `${base} The command you are exercising is \`${target}\`.`;
}
```

### close()

```ts
async close(): Promise<void> {
  if (!this._sessionName) return;
  const sessionName = this._sessionName;
  const descendants = this.bashPid !== null ? listDescendants(this.bashPid) : [];

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

### Orchestrator wiring

One-line change in `buildDefaultAdapter` (src/runs/orchestrator.ts:160):

```diff
- return new TUIAdapter({ contextRoot, credentialResolver });
+ return new TUIAdapter({ contextRoot, runDir, logger, credentialResolver });
```

`outDir` is already passed as `runDir` to `buildDefaultAdapter` (post-PRI-1608, line 186) — no further plumbing needed.

### CLI close() — simplified

`CLIAdapter.close()` collapses from the current ~55-line escalation ladder to:

```ts
async close(): Promise<void> {
  if (!this.proc || this.pgid === null) return;
  const pgid = this.pgid;
  const bashPid = this.proc.pid;
  const descendants = listDescendants(bashPid);

  try { process.kill(-pgid, "SIGKILL"); } catch { /* already dead */ }
  await this.awaitExitWithin(500); // bound the wait; SIGKILL is fast

  let reaped = 0;
  for (const pid of descendants) {
    try { process.kill(pid, "SIGKILL"); reaped++; } catch { /* already dead */ }
  }
  if (reaped > 0 && this.logger) {
    this.logger.logEvent("cli_shell_descendants_reaped", {
      pgid, descendantCount: descendants.length, reapedCount: reaped,
    });
  }
  this.cleanupRefs();
}
```

Removed: `GRACE_MS`, the `\nexit\n` write-and-await, the SIGHUP step, `logForceKilled`, the `cli_shell_force_killed` event, and the `reapDescendants` helper (folded inline). `awaitExitWithin` and `cleanupRefs` survive.

## Tests

### Unit (`test/adapters/tui/adapter.test.ts`)

Mirror CLI's `f91c425` diff:

- `beforeEach` allocates a `runDir = mkdtempSync(...)`; `afterEach` removes it.
- All `new TUIAdapter()` calls pass `{ runDir }`.
- Existing "starts process in tmux and reads output" test: change `start("sh -c \"echo 'hello from tmux'; sleep 10\"")` to `start("echo hello")` (informational) plus a `type("echo 'hello from tmux'\n")` after a short settle, then assert.
- Existing "sends keystrokes via tmux" test: change `start("bc -q")` to `start("bc")` plus `type("bc -q\n")` to launch bc, then `type("2+3")` + `press("Enter")` as before.
- describeTarget test: assert it contains `bash`, contains the target, and contains `exit` (drop "already running"/"do not retype").
- Capture/ANSI tests: keep the `printf … sleep 10` pattern but issue it via `type(...)` after starting bash.

### New unit test: descendant reap

```ts
test("close reaps backgrounded descendants", async () => {
  adapter = new TUIAdapter({ runDir, logger });
  await adapter.start("informational");
  await new Promise(r => setTimeout(r, 200));
  await adapter.type("sleep 60 &\n");
  await new Promise(r => setTimeout(r, 300));
  // Capture the sleep pid from the screen ("[1] 12345").
  const screen = await adapter.readScreen();
  const match = screen.match(/\[\d+\]\s+(\d+)/);
  expect(match).not.toBeNull();
  const sleepPid = Number(match![1]);

  await adapter.close();
  await new Promise(r => setTimeout(r, 200));
  // process.kill(pid, 0) throws ESRCH for a dead pid.
  expect(() => process.kill(sleepPid, 0)).toThrow();
});
```

### e2e

- `test/e2e/tui-nano.test.ts`: in both tests, allocate `runDir`, construct `new TUIAdapter({ runDir })`, change `start("nano …")` to `start("nano")` and prepend a `step("call_0", "type", { text: \`nano ${tempFile}\n\` })` ahead of the existing `read_screen` script.
- `test/e2e/tui-colored-alphabet.test.ts`: same shape — pass `{ runDir }`, prepend a launch-command type step.

### CLI test updates

`test/adapters/cli-adapter.test.ts` (per the f92e98b additions) has the following test cases to revisit:

- **Keep & adjust:** orphan-reap tests, descendant-walk tests, prompt-response compatibility test — these still apply.
- **Remove:** graceful-exit test (no graceful step), half-typed-line test (no `\nexit\n` flush), "SIGHUP suffices" test (no SIGHUP step), `cli_shell_force_killed` event tests.
- **Add:** a test that close() emits `cli_shell_descendants_reaped` when a `&` job was backgrounded, and emits no close event when nothing was reaped.

`test/adapters/cli/adapter.test.ts` keeps its current behavior — none of its tests touch the escalation ladder directly.

## Out of scope

- **`examples/todo/run-tui.sh` deletion + README rewording.** Once the adapter owns scratch+cwd, the fixture-side launcher parallels the already-deleted `run-cli-shell.sh`. Removing it (and updating the eight TODO story cards' agent-visible prose where it implies "the TUI is already running") is a separate follow-up commit — parallel to `556c3f0` for CLI. Flagging here so it isn't lost.
- **A graceful-exit attempt for either adapter.** Both adapters now go straight to SIGKILL. Politeness has no value for a test-harness session.
- **Sharing `KEY_MAP` between adapters.** They use different transport notations (raw bytes vs. tmux send-keys names) — no useful overlap.

## Risks

1. **`tmux list-panes` race after `new-session -d`.** Detached new-session returns once the session exists; the pane process should be live. If we observe occasional unparseable pid output in CI, retry once with a 50ms sleep before failing. Not pre-emptively added — too speculative.
2. **`bash --norc --noprofile -i` prompt rendering in 120×40.** The default PS1 is `\s-\v\$` which fits comfortably. No PS1 customization needed; we want the shell to look like a shell.
3. **macOS vs. Linux `ps` flag compatibility.** `ps -ax -o pid=,ppid=` works on both (already proven by CLI). No change.
