# Spec: Time budget + stuck-handling for the agent loop

**Linear:** PRI-1557
**Author:** Brienne (Bob c31c453f)
**Date:** 2026-05-11
**Status:** Draft — pending Matt sign-off

## Why

Gauntlet's only loop-termination knob today is `maxTurns` (default 50, hard cap 200). Two complaints with that:

1. **Turns are a poor proxy for "don't run forever."** A turn can be a 200ms tool call or a 30s reasoning blob. What operators actually have intuition for is wall-clock minutes. Turns are an implementation detail.
2. **There is no stuck-handling.** The agent will retry the same failing action 30 times before the counter trips. It exhausts its budget on a single dead-end instead of stopping, summarizing, and handing back useful "I got stuck on X" signal.

The fix is two changes that ship together because they're not usefully separate:

- Replace the turn cap with a **wall-clock time budget**.
- Steer the model to **recognize stuckness and give up gracefully**, via prompt — not detector code.

## Behavior

### Time budget (mechanical enforcement)

The agent loop runs until either:
- The model calls `report_result` (existing path, unchanged), or
- The wall-clock deadline passes.

When the deadline passes, the loop exits and falls through to the existing PRI-1326 grace-turn machinery, which injects a SYSTEM-REMINDER and asks the model for one final `report_result` with status `investigate`. The reminder text changes from "you used all N turns" to "you used your N-second time budget."

**Deadline granularity:** checked **between turns only**. An in-flight tool call is not interrupted; per-tool timeouts already exist (`DEFAULT_TOOL_TIMEOUT_MS = 30000`). Worst-case overrun is one tool-timeout (~30s).

**Default budget:** 5 minutes (300_000ms). Arbitrary; tunable later.

### Stuck-handling (prompt steering, no detector)

The system prompt gains a short block telling the model:
- What counts as stuck: repeated attempts at the same action with no observable progress.
- The retry budget: ~5 attempts by default.
- What to do when stuck: call `report_result` with status `investigate`, summarize what was tried, and put concrete recommendations in `observations` (kind `suggestion`).

The retry count is **not enforced in code** — the model decides. It's a tunable number injected into the prompt (default 5), exposed as `--max-stuck-retries`.

### Turn count: observational only

`turns` continues to increment per LLM call and is reported in `usage.turns` and `run.jsonl` exactly as today. It is **not** a loop terminator. The `medianTurns` run-set stat stays.

## Public surface changes

### CLI

**Removed:**
- `--turns <n>` flag (all four occurrences in `src/cli/args.ts`: run, run-one, batch, serve)
- `--turns` help text for run / run-one / batch / serve / config commands

**Added:**
- `--max-time <duration>` — accepts duration string (`5m`, `300s`, `90s`). On invalid input, error and exit. Applies to run, run-one, batch, serve (as default for served runs).
- `--max-stuck-retries <n>` — positive integer. Applies to same commands.

### Env vars

**Removed:**
- `GAUNTLET_TURNS`
- `GAUNTLET_MAX_TURNS_CAP`

**Added:**
- `GAUNTLET_MAX_TIME` — duration string, same parser as CLI flag
- `GAUNTLET_MAX_STUCK_RETRIES` — positive integer

### HTTP API (`POST /api/run`)

**Removed:**
- `body.turns` — rejected with 400 if present (clean error: "field `turns` is no longer accepted; use server-level `--max-time`")
- `TurnsTooHighError`, `turns_too_high` error code

**Added:** nothing in v1. If a per-run override is needed later, add `body.maxTimeMs` then.

### Config (`loadConfig` shape in `src/config.ts`)

**Removed:** `defaultTurns`, `maxTurnsCap`, related `sources` fields.

**Added:**
- `defaultBudgetMs: number` — default 300_000 (5 min). Source precedence: CLI flag > env > default.
- `defaultMaxStuckRetries: number` — default 5. Same precedence.

`gauntlet config` output updated accordingly.

### AgentOptions (`src/agent/agent.ts`)

**Removed:** `maxTurns?: number`

**Added:**
- `budgetMs: number` — required. No default at the agent layer (caller threads through from config). Removing the default at this layer enforces the contract that callers know what budget they're granting.
- `maxStuckRetries: number` — required, same rationale.

### Evidence events

**`run_start` event** (`src/evidence/logger.ts`):
- Remove `maxTurns: number`
- Add `budgetMs: number`
- Add `maxStuckRetries: number`

**Renamed event:** `max_turns_reminder` → `deadline_reminder`. Payload: `{ budgetMs, elapsedMs }`.

**Renamed event:** `max_turns_grace_malformed_report` → `deadline_grace_malformed_report`.

**Unchanged:** `usage.turns` in `run_end` event and `VetResult.usage.turns`.

### CLI pretty stream

Fixtures (`test/cli/stream/fixtures/*.pretty.txt`) and the renderer:

```
before:  max turns 50
         turns     1 / 50

after:   max time  5m
         turns     1   (no denominator — turns is observational)
```

The "X turns" line in the batch-table summary stays as-is (e.g. "7 turns" in `batch-table.test.ts:295`).

### System prompt

A new section is added to `buildSystemPrompt` (`src/agent/prompts.ts`). Wording (exact text TBD in implementation, but shape is):

```
## When to stop

You have a time budget for this run. Keep moving and don't dwell.

If you find yourself trying the same action 5+ times without making progress —
the same selector failing, the same navigation not happening, the same form
not advancing — STOP. Call report_result with status "investigate" and:
  - In summary, describe what you were trying to do.
  - In reasoning, explain where you got stuck.
  - Add observations (kind: "suggestion") with concrete recommendations
    for whoever picks this up.

A run that ends with a clear "stuck on X" report is more valuable than one
that burns its time budget hammering at a dead end.
```

The "5+" number is parameterized on `maxStuckRetries`.

## Non-goals

- **Token budget.** Defer. Easy to add as a parallel mechanism later; not required to land this.
- **Mechanical stuck-detection.** Defer. The prompt-steered approach is the v1 contract. If we observe the model failing to self-recognize stuckness, revisit with a detector that compares action keys + observed state hashes.
- **Per-run HTTP override of time budget.** Defer until a caller needs it.
- **Interrupting in-flight tool calls when the deadline trips.** The per-tool timeout already exists; mid-call interruption is messy and out of scope.

## Risks / open questions

- **Model might not self-recognize stuckness in practice.** Mitigation: the time budget is the hard backstop. If the prompt steering proves weak, follow-up ticket for a mechanical detector. The grace-turn reminder always fires on deadline, so we still get *a* report.
- **5 minutes might be too short for some scenarios.** Tunable per-invocation via `--max-time`. If real-world data shows the default is wrong, raise it.
- **Duration parsing.** Need to pick a parser. Recommend: simple regex accepting `\d+(ms|s|m|h)?` (no unit = seconds), reject anything else. No need for an external lib.

## Migration

No deprecation period: `--turns` and `body.turns` were not consumer-facing per Matt. Existing references in tests are updated to the new shape in the same commit.

## What gets touched (recon, not a plan)

For scope-sizing only — the Plan will enumerate concretely.

- `src/agent/agent.ts` — loop condition, options shape, reminder text, event names
- `src/agent/prompts.ts` — new section
- `src/config.ts` — full reshape of turn-related fields
- `src/cli/args.ts` — flag removal/addition, help text
- `src/cli/config-command.ts` — config output reflects new fields
- `src/evidence/logger.ts` — `run_start` event shape
- `src/runs/orchestrator.ts` (or wherever AgentOptions get assembled) — pass through new fields
- HTTP API route handler — reject `body.turns`
- CLI pretty stream renderer + fixtures
- Tests: `test/agent/agent.test.ts`, `test/api/caps.test.ts`, `test/cli/{run,batch,run-one}.test.ts`, `test/cli/stream/*`, `test/evidence/logger.test.ts`, `test/evidence/run-set-writer.test.ts`, `test/runs/orchestrator.test.ts`, `test/ui/transcript.test.ts` (consumes `run_start`)
- UI? — check if `ui/src/**` displays `maxTurns` from `run_start`; if so, update.
