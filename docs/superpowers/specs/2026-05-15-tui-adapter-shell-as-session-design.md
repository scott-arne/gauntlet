# TUI adapter — shell-as-session model

**Author:** Penric@1810bf08 (Opus 4.7)
**Parallel to:** PRI-1608 (CLI adapter shell-as-session)

---

## Problem

The CLI adapter now spawns an interactive `bash` at `start()` and treats `--target` as informational; the agent types the target as a command into that shell (PRI-1608, commit `f91c425`). The TUI adapter is still on the older model: `start(target)` launches the target program *directly* as the tmux pane process. Two follow-on problems:

1. **Asymmetry.** Fixtures and story authors learn two different mental models — CLI's "you're at a shell, type commands" vs. TUI's "your program is already running." When a project supports both adapters against the same target (the TODO fixture does), the cards diverge mechanically.
2. **No scratch isolation in the adapter.** CLI now owns `runDir/scratch` as the shell's cwd. TUI relies on fixture-side launchers (e.g. `examples/todo/run-tui.sh`) to set up isolated working dirs. The adapter has no hand in it, so the orchestrator can't depend on it.

A smaller, secondary concern: `close()` today is a single `tmux kill-session`. That terminates the pane process group, but interactive bash inside the pane puts each backgrounded `&` job in its own pgrp — those orphan out to `init` when the session dies. We have no descendant reap.

## Decision

Bring the TUI adapter in-line with the CLI shell-as-session model, adapted for the tmux pane shape:

- The pane hosts an interactive `bash --norc --noprofile -i`, sized to the 120×40 grid, with cwd = `runDir/scratch`.
- The `target` argument to `start()` is informational only — surfaced in `describeTarget` so the agent's system prompt names the command it should type.
- `close()` snapshots bash's descendant pids before issuing `tmux kill-session`, then SIGKILLs the snapshot to reap any orphaned backgrounded jobs.

`read_output` does **not** appear on the TUI side. `read_screen` already plays the role of "what's currently visible" and is retained unchanged.

### Why not a graceful-exit escalation ladder (CLI parity)

CLI escalates `\nexit\n` → SIGHUP pgrp → SIGKILL pgrp because writing to bash's stdin is a *soft* request: bash may be blocked in a child's read, in vi mode, or piping through `less`. There is no soft-request equivalent for a tmux pane — `tmux kill-session` is itself the authoritative kill. We therefore skip the ladder and emit only a single "descendants reaped" observability event when the snapshot was non-empty.

## Design

### Module shape

```
src/runtime/process-tree.ts        (new, ~30 LOC) — exports listDescendants(root: number)
src/adapters/cli/adapter.ts        — import listDescendants from runtime/process-tree
src/adapters/tui/adapter.ts        — import listDescendants; restructure start/close
src/runs/orchestrator.ts           — forward runDir + logger to TUIAdapter
```

`listDescendants` is lifted from `cli/adapter.ts` verbatim. No behavior change for CLI. Two callers today, room for more (any future adapter that wraps an interactive shell will want it).

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

### Re-validate CLI

CLI's tests must still pass after the `listDescendants` lift. The function is moved verbatim, but a quick `bun test test/adapters/cli/` ensures no import path was missed.

## Out of scope

- **`examples/todo/run-tui.sh` deletion + README rewording.** Once the adapter owns scratch+cwd, the fixture-side launcher parallels the already-deleted `run-cli-shell.sh`. Removing it (and updating the eight TODO story cards' agent-visible prose where it implies "the TUI is already running") is a separate follow-up commit — parallel to `556c3f0` for CLI. Flagging here so it isn't lost.
- **CLI-style close escalation ladder.** Explicitly skipped — `tmux kill-session` is authoritative, no soft-request layer to retry.
- **Sharing `KEY_MAP` between adapters.** They use different transport notations (raw bytes vs. tmux send-keys names) — no useful overlap.

## Risks

1. **`tmux list-panes` race after `new-session -d`.** Detached new-session returns once the session exists; the pane process should be live. If we observe occasional unparseable pid output in CI, retry once with a 50ms sleep before failing. Not pre-emptively added — too speculative.
2. **`bash --norc --noprofile -i` prompt rendering in 120×40.** The default PS1 is `\s-\v\$` which fits comfortably. No PS1 customization needed; we want the shell to look like a shell.
3. **macOS vs. Linux `ps` flag compatibility.** `ps -ax -o pid=,ppid=` works on both (already proven by CLI). No change.
