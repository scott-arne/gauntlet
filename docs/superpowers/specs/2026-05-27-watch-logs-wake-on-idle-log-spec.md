# watch_logs + wake_on_idle_log — block-until-idle primitive for long-haul runs

**Linear:** PRI-1864
**Related:** PRI-1692 (sen v2 `job_notify` — same problem family, different surface)
**Author:** Saga@eb3d1a89 (Opus 4.7)

---

## Problem

On long-haul TUI runs (driving Codex or Claude Code through a 30–60 minute task), the Gauntlet-Agent has no good way to *wait*. Its current pattern is bash `sleep 25 && echo done` followed by `read_screen`, repeated. Each cycle burns a full inference turn for 25 seconds of real time.

Reference failure: `sdd-go-fractals-codex-20260527T202310Z-4ad3`. 139 turns, 31 minutes in, ~7M cached-read tokens. Across the final ~10 turns the assistant prefix accumulated near-empty messages with identical bash args; eventually turn 139 returned `outputTokens=2`, no tool calls, `stop_reason=end_turn`, and the run silently failed as `status:investigate`. The exact triggering mechanism — self-priming on the empty-prefix pattern vs. some other cause — isn't proven from one run, but the *outcome* (silent catatonic exit at the end of a polling loop) is independent of the precise cause.

The deeper issue: inference at ~0.5 Hz observing a process whose meaningful events arrive at maybe 0.001 Hz pays a model turn for every second of nothing happening. The polling loop is paying for inference it has nothing to do with.

## Decision

Add two tools to `buildSharedTools` (`src/agent/shared-tools.ts`), the existing seam through which `bash`, `read`, and `fetch_credential` are already vended to every adapter (TUI/CLI/web):

```
watch_logs({ glob: string }) → { watching: string[] }

wake_on_idle_log({ idle_ms, timeout_ms })
  → { reason: "idle" | "new_file" | "timeout",
       path?, last_activity_ms_ago, watching, clamped? }
```

The primitive *blocks one inference turn* until one of three conditions, and **wakes on idle, not on activity**. A busy subagent appending every few seconds keeps the idle timer reset; the agent stays asleep. The agent wakes when something is actually worth a decision.

### Why these are the right wake conditions

| condition  | semantics                                          | why it wakes                                     |
|------------|----------------------------------------------------|--------------------------------------------------|
| `idle`     | no appends across all watched paths for `idle_ms`  | stack quiesced — assess whether work finished or stuck |
| `new_file` | a new file matches a watched glob                  | new subagent spawned — qualitatively new state worth a glance |
| `timeout`  | absolute `timeout_ms` elapsed                      | safety: don't wait past the prompt-cache TTL     |

### Why screen change is excluded

Spinners, clocks, and progress counters make screen state a noisy oracle — most "changes" are visual chrome with no information content. Any meaningfully new screen state is preceded by log activity, which the log-watch already catches. The agent can `read_screen` after waking if it wants the visual; baking it into the wake set adds false positives.

### Cache-TTL hard ceiling on timeout_ms

Anthropic's prompt cache TTL is 5 minutes. Waiting longer than that means the next inference turn reads the full conversation context uncached, which dominates the savings from blocking. So:

- `timeout_ms` is **hard-clamped to 240_000** (4 min) inside the tool, with `clamped: true` surfaced in the result.
- `idle_ms` has a **5_000 floor** to prevent foot-shooting (a tiny `idle_ms` would burn a turn on every micro-pause). Also clamped silently, also surfaced.
- Non-number / negative / zero values for either field: rejected with a clear error rather than silently floored, so the model sees the misuse instead of getting confusing behavior.
- Defaults: `idle_ms=60_000`, `timeout_ms=240_000`.
- Tool description names the 4-min ceiling so the model has the *why* available.

The cost frame: not "one turn per 25-min wait" but at worst "one turn per 4-min ceiling, plus one turn per `new_file` event." For a 10-task SDD run with subagents, that's plausibly 20–40 turns vs. the ~120 turns the sleep-poll baseline burns — a real win but not the 10× the back-of-envelope suggested. The structural win matters more than the raw turn count: a polling loop made of empty turns can degenerate into the catatonic-exit failure; a loop of one turn per 4-minute block cannot.

### Why this lives in SharedTools, not the TUI adapter

`buildSharedTools(opts)` in `src/agent/shared-tools.ts` already vends `bash`, `read`, and `fetch_credential` to every adapter. Adapters compose its `definitions()` into their own `toolDefinitions()` and route by `canExecute(name)`. The new tools depend on the filesystem and the evidence stream — neither is adapter-specific. Adding them to `buildSharedTools` means every adapter (TUI, CLI, web) gets them for free with no per-adapter wiring.

The TUI adapter stays target-agnostic. The Codex-vs-Claude knowledge — *where* rollout logs live — is in the prose HOWTO that barf bakes per run, consistent with the existing seam.

### Watcher mechanics

A single `WatchManager` instance is constructed inside `buildSharedTools` and shared by both tools. Concretely:

- **Register-time behavior.** `watch_logs({ glob })` adds the glob to the manager. Globs are stored as patterns *and* re-evaluated continuously, not snapshotted at registration. A glob whose containing directory doesn't exist yet (Codex's `$CODEX_HOME/sessions/` before launch) is held: the manager polls for new directory entries and starts watching matching files when they appear.
- **What counts as "append".** Size-increase OR mtime-newer-than-last-poll. Either resets the idle timer. Size-shrink (truncation) is also treated as activity (so a log rotation doesn't read as "idle"); the watcher does not error, it just records last_activity_ms.
- **`new_file` detection.** When the directory scan picks up a path that matches a watched glob *and the manager has not seen before*, that fires `new_file`. Subsequent appends to that same file are just activity.
- **`watch_logs` idempotency.** Calls accumulate — repeated calls with the same glob are no-ops; calls with new globs add to the set. There is no remove operation; the watch set grows monotonically over a run. The result always echoes the full current set so context-compressed agents can self-confirm.
- **Multiple concurrent `wake_on_idle_log` calls.** Disallowed — the second call in a single agent turn returns immediately with `reason: "concurrent_call"` rather than starting a parallel wait. This is defensive: a degenerate model state shouldn't be able to fan out blockers.

## Empty-end_turn safety net

Independent of the rest, the agent runner gets a small change: if `llm_response` returns with `stopReason=end_turn`, no tool calls, and `outputTokens < 5`, treat it as a soft error. Inject one nudge ("you returned empty content; either call `report_result` or take another action") and re-request once before ending the run.

This converts the silent catatonia mode into either recovery or a labeled failure. It lands regardless of whether the rest of the design ships — small, localized, and prevents the silent-fail shape that started this investigation.

## HOWTO patches (barf-side)

Both HOWTOs (`superpowers-evals/coding-agents/codex-context/HOWTO.md` and `claude-context/HOWTO.md`) get edited to:

1. **Name the rollout glob for that target.**
   - Codex: `$CODEX_HOME/sessions/**/rollout-*.jsonl` — the existing HOWTO documents a flat `sessions/rollout-*.jsonl`, but Codex actually nests by `YYYY/MM/DD/`. The patch fixes this inaccuracy at the same time.
   - Claude: `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl`.
2. **Instruct `watch_logs(...)` once after launch.**
3. **Instruct `wake_on_idle_log(idle_ms=60000, timeout_ms=240000)` between actions.**
4. **Demote `sleep`-based polling explicitly** — not just augment. Any current example that demonstrates the bash-sleep pattern gets rewritten or removed. Per the `feedback_new_tool_update_prompt_default` memory: adoption follows the prompt's *default verb*, so the new tool has to be presented as the new default and the old pattern has to be visibly demoted.

The tool descriptions stay generic (no SDD, Codex, Claude in the description text). The target-specific paths-to-watch live in the HOWTOs, consistent with the existing architecture: tools are generic, prose is per-target.

## Tool description doctrine

Load-bearing phrases (per `feedback_new_tool_update_prompt_default` in memory — adoption follows the system/adapter prompt's default verb, not the tool description alone, but the description still primes correctly):

- **"Block one inference turn"** — tells the model what it costs.
- **"Prefer this over sleep-based polling"** — names the existing pattern this replaces.
- **"Keep timeout_ms ≤ 240000 (4 min) — longer waits lose the model context cache"** — gives the *why* behind the clamp.

## Non-goals

- **First-line metadata parsing on `created` events** (parsing Codex's `session_meta` line to attach `{role, nickname, depth, parent_thread_id}` to new_file events). Deferred — the agent can `bash head -1 <path>` itself when it cares. Keeps the tool generic.
- **Harness-side pre-arming** via a new `RunRequestBody.watchGlobs` field. Possible later if context compression turns out to drop the `watch_logs` registration mid-run; for now, returning the current watch list in every `wake_on_idle_log` result is the cheaper mitigation.
- **Screen change as a wake trigger.** Excluded by design.
- **Per-target adapter config.** The TUI adapter stays generic; HOWTOs do the target-specific work.

## Acceptance

- `watch_logs` and `wake_on_idle_log` registered via `buildSharedTools` (`src/agent/shared-tools.ts`); available in TUI, CLI, web adapter runs without per-adapter wiring.
- `watch_logs` is idempotent and additive — repeated calls accumulate globs; result echoes the full watch set every call.
- A glob whose containing directory doesn't exist at registration is held and starts matching once the directory appears.
- `wake_on_idle_log` correctly fires on `idle`, `new_file`, `timeout`; correctly resets the idle timer on appends to any watched path (size-increase or mtime-newer; truncation also counts as activity).
- A second `wake_on_idle_log` call in one turn returns immediately with `reason: "concurrent_call"`.
- `timeout_ms` clamped to ≤ 240_000; `idle_ms` clamped to ≥ 5_000; both clamps surfaced via `clamped: true` in the result.
- Invalid values (negative, zero, non-number) rejected with a clear error.
- Empty-end_turn safety net: synthetic empty response triggers one re-request with a nudge; second empty response ends the run with a labeled reason (not silent `investigate`).
- Both HOWTOs updated; bash-sleep pattern demoted, not just augmented.
- End-to-end smoke against the reference long-haul scenario: turn count drops materially vs. the sleep-poll baseline; the run completes or fails with a labeled reason rather than silent catatonia.

## Cost / value

Reference failure: 139 turns, 7M cached-read tokens, 31 minutes, no usable output.

Sleep-poll baseline for a 30-min watch: 30 min ÷ 25s ≈ 72 cycles × 2 turns/cycle = ~140 turns. With `wake_on_idle_log(idle_ms=60000, timeout_ms=240000)`: ~7 ceiling-only turns plus one turn per `new_file` event (SDD typically spawns 15–25 subagents over a run), so realistic total ~25–35 turns. Real reduction roughly 4–5× on inference turns, not 10×.

The structural win is what matters: a polling loop of empty turns can degenerate into the catatonic-exit shape we observed; a loop of one turn per 4-minute block cannot. The empty-end_turn safety net catches that mode regardless, but `wake_on_idle_log` removes the conditions under which it forms.
