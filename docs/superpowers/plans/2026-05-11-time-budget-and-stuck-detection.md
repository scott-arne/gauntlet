# Time Budget + Stuck-Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gauntlet's `maxTurns` agent-loop terminator with a wall-clock time budget, and steer the model via prompt to recognize stuckness and call `report_result` gracefully after ~5 unproductive retries.

**Architecture:** A `parseDuration` utility converts CLI/env duration strings (`5m`, `300s`) to milliseconds. `config.ts` swaps `defaultTurns`/`maxTurnsCap` for `defaultBudgetMs`/`defaultMaxStuckRetries`. The agent loop (`src/agent/agent.ts`) becomes `while (Date.now() < deadline)` and the existing PRI-1326 grace-turn machinery is repointed at the new stop condition. A new system-prompt section tells the model what stuckness looks like and what to do about it. `--turns` is removed; `--max-time` and `--max-stuck-retries` replace it. The HTTP API rejects `body.turns` with a 400. `usage.turns` stays as an observational counter; `run_start.maxTurns` is renamed to `budgetMs`.

**Tech Stack:** TypeScript (Bun runtime), `bun:test`, Hono for the HTTP API, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-11-time-budget-and-stuck-detection-spec.md`
**Linear:** PRI-1557

---

## File Structure

**Create:**
- `src/util/parse-duration.ts` — `parseDuration(s: string): number` returns ms; throws on invalid input.
- `test/util/parse-duration.test.ts` — unit tests for the parser.
- `src/agent/prompts/stuck-handling.md` — system-prompt section telling the model when/how to give up.

**Modify:**
- `src/config.ts` — replace `defaultTurns`/`maxTurnsCap` and their env vars with `defaultBudgetMs`/`defaultMaxStuckRetries`; remove `TurnsTooHighError`; remove `turns` from `RUN_BODY_ALLOWED`; reject `body.turns` in `validateRunBody`.
- `src/agent/agent.ts` — replace turn-counter loop with deadline loop; rename grace events; update reminder text; swap `maxTurns?` for required `budgetMs` and `maxStuckRetries` on `AgentOptions`.
- `src/agent/prompts.ts` — load `stuck-handling.md` into the prompt with `{{MAX_STUCK_RETRIES}}` substitution.
- `src/agent/prompts/loader.ts` — extend `loadPromptFile` (or add a sibling) to support placeholder substitution (or inline the `.replace` at the call site — see Task 4).
- `src/evidence/logger.ts` — `RunStartFields`: replace `maxTurns: number` with `budgetMs: number` and `maxStuckRetries: number`.
- `src/runs/orchestrator.ts` — thread `budgetMs` and `maxStuckRetries` from config into `AgentOptions`; populate the new `RunConfigSnapshot` fields.
- `src/types.ts` — `RunConfigSnapshot`: replace `turns: number` with `budgetMs: number`; bump `RESULT_SCHEMA_VERSION` from 2 to 3; update the schema-version comment.
- `src/api/routes/run.ts` — remove `TurnsTooHighError` handling; drop the `maxTurnsCap` arg to `validateRunBody`.
- `src/cli/args.ts` — remove `--turns` from all allow-sets (`RUN_ALLOWED`, `SERVE_ALLOWED`, `CONFIG_ALLOWED`, and the derived `BATCH_ALLOWED`); add `--max-time` and `--max-stuck-retries`; update `RunArgs`/`BatchArgs`/`ServeArgs`/`ConfigArgs` and help text.
- `src/cli/config-command.ts` — emit `defaultBudgetMs` and `defaultMaxStuckRetries` instead of `defaultTurns`/`maxTurnsCap`.
- `src/cli/stream/pretty.ts` (or wherever the renderer lives) — change `max turns N` → `max time Xm`, drop `/N` denominator on the `turns` line.
- `ui/src/lib/transcript.ts` — `TranscriptModel.maxTurns` → `budgetMs`.
- `ui/src/lib/api.ts` — config shape `turns: number` → `budgetMs: number`.

**Test files touched (rewrite/migrate):**
- `test/agent/agent.test.ts` — the `maxTurns: 1` grace-turn test becomes a `budgetMs: 0` deadline test; all AgentOptions construction sites get `budgetMs`/`maxStuckRetries`.
- `test/api/caps.test.ts` — drop the `TurnsTooHighError` cases; replace with a `body.turns rejected` case.
- `test/cli/{run,run-one,batch}.test.ts` — config fakes get `defaultBudgetMs` and `defaultMaxStuckRetries` in place of `defaultTurns`.
- `test/cli/stream/*` — fixtures and assertions follow the renderer changes.
- `test/cli/stream/fixtures/{happy,failing-tool,fatal}.pretty.txt` — regenerate.
- `test/evidence/logger.test.ts` — `run_start` rows have `budgetMs` instead of `maxTurns`.
- `test/evidence/run-set-writer.test.ts` — no schema change to `usage.turns`; compile-fix only if anything broke.
- `test/runs/orchestrator.test.ts` — config fake + AgentOptions assertions.
- `test/ui/transcript.test.ts` — `maxTurns` references in test fixtures.
- `test/api/routes/run-snapshot.test.ts` — `defaultTurns: 1` in config fake → `defaultBudgetMs: 1000`.
- `test/api/shutdown.test.ts` — same.
- `test/cli/batch.test.ts` (specifically the `maxTurns: 20` assertions on run_start events) — `budgetMs` instead.

---

## Conventions

- **Bun test runner.** Run a single file with `bun test path/to/file.test.ts`. Run the whole suite with `bun test`.
- **`mock.module` is process-global** (see project memory `feedback_bun_mock_module_pollution.md`). Don't mock `src/config.ts` in unit tests — pass config explicitly through function args.
- **Commit messages:** terse, imperative. End every commit's metadata with the Co-Authored-By trailer in the format from the Bobiverse protocol (`Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)`). Exact body wording per task below.
- **Don't add backwards-compat shims.** Per project memory `feedback_no_prs.md`, this is a direct-to-main change for a pre-consumer surface — clean swap, no deprecation layers.

---

## Tasks

### Task 1: `parseDuration` utility

**Goal:** Pure function that accepts duration strings (`5m`, `300s`, `90s`, `1h`, `500ms`, `300`) and returns milliseconds. Bare numbers are treated as seconds. Throws a clear error on garbage input. Used by both CLI arg parsing and env var parsing.

**Files:**
- Create: `src/util/parse-duration.ts`
- Create: `test/util/parse-duration.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/util/parse-duration.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { parseDuration } from "../../src/util/parse-duration";

describe("parseDuration", () => {
  test("accepts plain integer as seconds", () => {
    expect(parseDuration("300")).toBe(300_000);
    expect(parseDuration("1")).toBe(1_000);
  });

  test("accepts ms suffix", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  test("accepts s suffix", () => {
    expect(parseDuration("90s")).toBe(90_000);
  });

  test("accepts m suffix", () => {
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1m")).toBe(60_000);
  });

  test("accepts h suffix", () => {
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  test("rejects negative numbers", () => {
    expect(() => parseDuration("-1s")).toThrow(/invalid duration/i);
  });

  test("rejects zero", () => {
    expect(() => parseDuration("0")).toThrow(/invalid duration/i);
    expect(() => parseDuration("0s")).toThrow(/invalid duration/i);
  });

  test("rejects unknown suffix", () => {
    expect(() => parseDuration("5x")).toThrow(/invalid duration/i);
  });

  test("rejects empty string", () => {
    expect(() => parseDuration("")).toThrow(/invalid duration/i);
  });

  test("rejects whitespace-only", () => {
    expect(() => parseDuration("   ")).toThrow(/invalid duration/i);
  });

  test("rejects non-numeric prefix", () => {
    expect(() => parseDuration("abc")).toThrow(/invalid duration/i);
    expect(() => parseDuration("5m extra")).toThrow(/invalid duration/i);
  });

  test("rejects fractional values", () => {
    expect(() => parseDuration("1.5m")).toThrow(/invalid duration/i);
  });

  test("error message includes the offending input", () => {
    try {
      parseDuration("xyz");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("xyz");
    }
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `bun test test/util/parse-duration.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement parser**

`src/util/parse-duration.ts`:

```ts
/**
 * Parse a duration string into milliseconds.
 *
 * Accepted forms:
 *   "300"   → 300_000 (bare integer = seconds)
 *   "500ms" → 500
 *   "90s"   → 90_000
 *   "5m"    → 300_000
 *   "1h"    → 3_600_000
 *
 * Throws on:
 *   - empty / whitespace-only input
 *   - non-integer values (e.g. "1.5m")
 *   - zero or negative values
 *   - unknown suffixes
 *   - trailing garbage
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error(`invalid duration "${input}": empty`);
  }

  const match = /^(\d+)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `invalid duration "${input}": expected integer with optional suffix ms|s|m|h`,
    );
  }

  const n = parseInt(match[1]!, 10);
  if (n <= 0) {
    throw new Error(`invalid duration "${input}": must be positive`);
  }

  const unit = match[2] ?? "s";
  switch (unit) {
    case "ms": return n;
    case "s":  return n * 1_000;
    case "m":  return n * 60_000;
    case "h":  return n * 3_600_000;
  }

  // Unreachable: the regex restricts to ms|s|m|h|absent.
  throw new Error(`invalid duration "${input}": unknown unit`);
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test test/util/parse-duration.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/util/parse-duration.ts test/util/parse-duration.test.ts
git commit -m "util: add parseDuration for time-budget CLI/env input

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

---

### Task 2: Config — swap turn knobs for budget knobs

**Goal:** Replace `defaultTurns`, `maxTurnsCap`, `GAUNTLET_TURNS`, `GAUNTLET_MAX_TURNS_CAP`, and `TurnsTooHighError` with `defaultBudgetMs`, `defaultMaxStuckRetries`, `GAUNTLET_MAX_TIME`, `GAUNTLET_MAX_STUCK_RETRIES`. Remove `turns` from `RUN_BODY_ALLOWED` and reject it in `validateRunBody`. Update the run-body `mergeRunConfig` shape.

**Files:**
- Modify: `src/config.ts`
- Modify: `src/cli/args.ts` (only enough to keep `loadConfig`'s `args.turns` typing consistent — full CLI work is Task 7; for now we just add `maxTime?: string` and `maxStuckRetries?: number` to `CliArgsInput`)
- Modify: `test/api/caps.test.ts`

- [ ] **Step 1: Read the current state**

Read `src/config.ts:1-310` end-to-end so you understand `AppConfig`, `RunRequestBody`, `EffectiveRunConfig`, `validateRunBody`, `mergeRunConfig`, and `TurnsTooHighError`.

- [ ] **Step 2: Write failing tests for the new shape**

Edit `test/api/caps.test.ts`. Replace the existing `describe("PRI-1478: turns cap (validateRunBody)", ...)` block with:

```ts
describe("validateRunBody: body.turns is rejected", () => {
  test("rejects any body.turns value with a clear 400-suitable error", () => {
    expect(() => validateRunBody({ target: "http://x", turns: 5 }, {}))
      .toThrow(/`turns` is no longer accepted/);
  });

  test("accepts body without turns", () => {
    expect(() => validateRunBody({ target: "http://x" }, {})).not.toThrow();
  });
});
```

And remove the `TurnsTooHighError` import from the top of the file. Update or remove tests that referenced `maxTurnsCap` config / `GAUNTLET_MAX_TURNS_CAP` env. Add equivalents for `GAUNTLET_MAX_TIME` and `GAUNTLET_MAX_STUCK_RETRIES`:

```ts
describe("loadConfig: GAUNTLET_MAX_TIME and GAUNTLET_MAX_STUCK_RETRIES", () => {
  test("default budget is 5 minutes; default stuck retries is 5", () => {
    const c = loadConfig({ args: {}, env: {} });
    expect(c.defaultBudgetMs).toBe(300_000);
    expect(c.defaultMaxStuckRetries).toBe(5);
  });

  test("GAUNTLET_MAX_TIME accepts duration strings", () => {
    const c = loadConfig({ args: {}, env: { GAUNTLET_MAX_TIME: "30s" } });
    expect(c.defaultBudgetMs).toBe(30_000);
  });

  test("GAUNTLET_MAX_STUCK_RETRIES accepts positive integer", () => {
    const c = loadConfig({ args: {}, env: { GAUNTLET_MAX_STUCK_RETRIES: "3" } });
    expect(c.defaultMaxStuckRetries).toBe(3);
  });

  test("CLI --max-time overrides env", () => {
    const c = loadConfig({
      args: { maxTime: "10s" } as any,
      env: { GAUNTLET_MAX_TIME: "5m" },
    });
    expect(c.defaultBudgetMs).toBe(10_000);
  });

  test("invalid GAUNTLET_MAX_TIME throws with the offending value", () => {
    expect(() =>
      loadConfig({ args: {}, env: { GAUNTLET_MAX_TIME: "xyz" } }),
    ).toThrow(/GAUNTLET_MAX_TIME.*xyz/);
  });
});
```

(Adapt imports — `validateRunBody` import line stays; remove `TurnsTooHighError`.)

- [ ] **Step 3: Run the tests, confirm they fail**

Run: `bun test test/api/caps.test.ts`
Expected: FAIL — `defaultBudgetMs` is undefined, `validateRunBody` doesn't yet reject `turns`, etc.

- [ ] **Step 4: Edit `src/config.ts`**

Apply these changes:

(a) `AppConfig` interface — replace:

```ts
defaultTurns: number;
maxTurnsCap: number;
```

with:

```ts
/**
 * Wall-clock budget for an agent run in milliseconds. The agent loop
 * exits when `Date.now() >= deadline`. Default 300_000 (5 min); override
 * via `--max-time` or `GAUNTLET_MAX_TIME`.
 */
defaultBudgetMs: number;
/**
 * Hint to the model (injected into the system prompt) for how many
 * retries on the same action before giving up and calling
 * report_result with status=investigate. Not enforced in code.
 */
defaultMaxStuckRetries: number;
```

(b) `sources` map — same swap inside the nested type:

```ts
defaultBudgetMs: "default" | "env" | "flag";
defaultMaxStuckRetries: "default" | "env" | "flag";
```

(c) `RunRequestBody` and `EffectiveRunConfig` — remove `turns?: number` / `turns: number` lines entirely (no successor; per-run budget override over HTTP is out of scope).

(d) Remove `turns` from `RUN_BODY_ALLOWED`:

```ts
const RUN_BODY_ALLOWED = new Set(["target", "model", "chrome", "adapter", "viewport", "saveScreencast", "passes"]);
```

(e) Delete the `DEFAULT_MAX_TURNS = 50` constant and `DEFAULT_MAX_TURNS_CAP = 200`. Add:

```ts
export const DEFAULT_BUDGET_MS = 300_000;
export const DEFAULT_MAX_STUCK_RETRIES = 5;
```

(f) Delete the entire `TurnsTooHighError` class and its export.

(g) Rewrite the `validateRunBody` `turns` branch. Where it currently does the typeof/integer/cap check, replace with:

```ts
if (bodyObj.turns !== undefined) {
  throw new Error(
    "run request body: field `turns` is no longer accepted; configure budget server-side via --max-time or GAUNTLET_MAX_TIME",
  );
}
```

Delete the local `let turns` declaration and the `turns,` line in the returned object literal. Drop the `opts.maxTurnsCap` parameter — `validateRunBody`'s opts object can be empty now (keep the signature for forward-compatibility, just empty type).

(h) `mergeRunConfig`: drop `turns: body.turns ?? app.defaultTurns,` from the returned object.

(i) `loadConfig`: replace the entire `defaultTurns` resolution block (lines ~447-465) with:

```ts
import { parseDuration } from "./util/parse-duration";

// ...

// defaultBudgetMs — wall-clock budget for the agent loop.
let defaultBudgetMs = DEFAULT_BUDGET_MS;
let budgetSource: "default" | "env" | "flag" = "default";
if (env.GAUNTLET_MAX_TIME) {
  try {
    defaultBudgetMs = parseDuration(env.GAUNTLET_MAX_TIME);
  } catch (err) {
    throw new Error(`Invalid GAUNTLET_MAX_TIME "${env.GAUNTLET_MAX_TIME}": ${(err as Error).message}`);
  }
  budgetSource = "env";
}
if (args.maxTime !== undefined) {
  try {
    defaultBudgetMs = parseDuration(args.maxTime);
  } catch (err) {
    throw new Error(`Invalid --max-time "${args.maxTime}": ${(err as Error).message}`);
  }
  budgetSource = "flag";
}

// defaultMaxStuckRetries — prompt-injected, not enforced.
let defaultMaxStuckRetries = DEFAULT_MAX_STUCK_RETRIES;
let stuckSource: "default" | "env" | "flag" = "default";
if (env.GAUNTLET_MAX_STUCK_RETRIES) {
  const parsed = parseInt(env.GAUNTLET_MAX_STUCK_RETRIES, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid GAUNTLET_MAX_STUCK_RETRIES "${env.GAUNTLET_MAX_STUCK_RETRIES}": expected positive integer`);
  }
  defaultMaxStuckRetries = parsed;
  stuckSource = "env";
}
if (args.maxStuckRetries !== undefined) {
  if (!Number.isInteger(args.maxStuckRetries) || args.maxStuckRetries < 1) {
    throw new Error(`Invalid --max-stuck-retries ${args.maxStuckRetries}: expected positive integer`);
  }
  defaultMaxStuckRetries = args.maxStuckRetries;
  stuckSource = "flag";
}
```

(j) Delete the entire `maxTurnsCap` resolution block (lines ~493-499 plus output / source-tracking references). Replace the `defaultTurns,` / `maxTurnsCap,` lines in the returned config object with:

```ts
defaultBudgetMs,
defaultMaxStuckRetries,
```

And in the `sources` block:

```ts
defaultBudgetMs: budgetSource,
defaultMaxStuckRetries: stuckSource,
```

- [ ] **Step 5: Edit `src/cli/args.ts` — extend `CliArgsInput` only**

Add `maxTime?: string` and `maxStuckRetries?: number` to `CliArgsInput`. (Full CLI parsing is Task 7. This is enough to keep `loadConfig`'s type-check happy.)

Locate the `CliArgsInput` interface (grep for it). Add:

```ts
maxTime?: string;
maxStuckRetries?: number;
```

Remove `turns?: number` from `CliArgsInput` if present, and remove every `turns: parseIntFlag(flags.turns, "--turns")` occurrence — but **leave the flag-parsing scaffolding alone for now**; Task 7 will wire the new flags. Just ensure config-resolution code path doesn't reference `args.turns`.

If this causes ripple type errors in arg-parser bodies, do the minimum surgery to remove `turns:` from each `{...}` constructed `cli:` object. The full `--max-time` parsing happens in Task 7.

- [ ] **Step 6: Run the config tests**

Run: `bun test test/api/caps.test.ts`
Expected: PASS for `validateRunBody` rejection and `loadConfig` budget/stuck tests.

Run: `bun tsc --noEmit`
Expected: type-check passes. Fix any callers in `src/cli/*.ts` that still pass `turns:` into `CliArgsInput` — the fix is to delete the line.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/cli/args.ts src/util/parse-duration.ts test/api/caps.test.ts
git commit -m "config: replace defaultTurns/maxTurnsCap with budget+stuck knobs

Drop TurnsTooHighError; reject body.turns at validateRunBody with a
clear error. AppConfig gains defaultBudgetMs (default 300_000) and
defaultMaxStuckRetries (default 5). Env: GAUNTLET_MAX_TIME (duration
string), GAUNTLET_MAX_STUCK_RETRIES.

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

---

### Task 3: Agent loop — deadline-based termination

**Goal:** Replace the turn-counter loop in `runAgent` with a wall-clock deadline loop. Swap `maxTurns?` for required `budgetMs` and `maxStuckRetries` on `AgentOptions`. Rename the `max_turns_*` events. Update the grace-turn reminder text. Keep `usage.turns` incrementing (observational only).

**Files:**
- Modify: `src/agent/agent.ts`
- Modify: `test/agent/agent.test.ts`

- [ ] **Step 1: Read current agent loop**

Read `src/agent/agent.ts` end-to-end. Focus on lines 11-12 (constants), 14-56 (AgentOptions), 111-220 (loop setup), 211-372 (main loop), 374-458 (grace-turn path).

- [ ] **Step 2: Migrate the existing "max-turns reminder" test to use a budget**

Open `test/agent/agent.test.ts`. Find the test that uses `maxTurns: 1` (around line 683, plus the assertion at 712 checking `"all 1 of your available turns"`).

Replace its `AgentOptions` block with:

```ts
{
  runId: "test-run",
  budgetMs: 0,           // deadline already passed → grace turn fires on the first iteration
  maxStuckRetries: 5,
}
```

Update the assertion at line 712:

```ts
expect(String(lastMessage.content)).toContain("time budget");
```

And the `logEvent` assertion at line 723:

```ts
expect(reminder?.params.budgetMs).toBe(0);
```

The reminder-event name moves from `max_turns_reminder` to `deadline_reminder`. Update wherever the test reads that event name.

For every other test in `agent.test.ts` that constructs `AgentOptions`, **replace `maxTurns: <N>` with `budgetMs: 600_000, maxStuckRetries: 5`** — a 10-minute budget is far beyond any unit-test-loop scenario, so the timing path is not exercised. (Keep the in-loop assertions on `usage.turns` exactly as they are — the counter still increments.)

For the test "Increase --turns for this scenario" string literal (line 670 and 692), update the observation description to `"Configure a longer --max-time for this scenario"`.

- [ ] **Step 3: Run agent tests — confirm they fail**

Run: `bun test test/agent/agent.test.ts`
Expected: FAIL — `budgetMs` is not a recognized field, etc.

- [ ] **Step 4: Edit `src/agent/agent.ts` — option shape and loop**

(a) Delete `const DEFAULT_MAX_TURNS = 50;` (top of file). Add nothing — the default lives in config; the agent layer requires the caller to supply.

(b) Replace the `AgentOptions.maxTurns?` field with:

```ts
/**
 * Wall-clock budget for the agent loop in milliseconds. The loop exits
 * when `Date.now() >= startTime + budgetMs`. Required: the orchestrator
 * threads this through from config; tests must construct deliberately.
 */
budgetMs: number;

/**
 * Hint injected into the system prompt for how many retries on the same
 * action before the model should give up. Not enforced in code.
 */
maxStuckRetries: number;
```

(c) In `runAgent`, locate:

```ts
let turns = 0;
const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
```

Replace with:

```ts
let turns = 0;
const { budgetMs, maxStuckRetries } = options;
const deadline = startTime + budgetMs;
```

(d) Replace the loop header:

```ts
for (let turn = 0; turn < maxTurns; turn++) {
```

with:

```ts
while (Date.now() < deadline) {
```

Adjust the closing block accordingly (a `while` loop reads better when paired with a `break`, but the existing code already uses `return` for early exits, so the body needs no structural changes).

(e) Replace the `logger.logRunStart` call — change `maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,` to:

```ts
budgetMs,
maxStuckRetries,
```

(f) Update the `max_tokens` early-exit reasoning string at line 303 — drop "turn ${turns}" or leave it (still a useful diagnostic; keep it).

(g) Update the post-loop "max turns reached" path:

- Rename `logger.logEvent("max_turns_reminder", { maxTurns });` → `logger.logEvent("deadline_reminder", { budgetMs, elapsedMs: Date.now() - startTime });`
- Rename `logger.logEvent("max_turns_grace_malformed_report", ...)` → `logger.logEvent("deadline_grace_malformed_report", ...)`
- Replace the reminder text. The new version:

```ts
const elapsedSec = Math.round((Date.now() - startTime) / 1000);
const reminderText =
  `<SYSTEM-REMINDER>\n` +
  `You have used your time budget (${elapsedSec}s of ${Math.round(budgetMs/1000)}s) without calling report_result. ` +
  `No more application tools are available — only report_result can be called now. ` +
  `This is your final response.\n` +
  `\n` +
  `Call report_result to end the run with an actionable summary:\n` +
  `  - Set status to "investigate" (the run did not complete).\n` +
  `  - In summary, describe what you did and what you observed.\n` +
  `  - In reasoning, explain where you got stuck and why you couldn't finish ` +
  `within the time budget.\n` +
  `  - Include concrete recommendations as observations (kind: "suggestion") ` +
  `for whoever picks this up next.\n` +
  `</SYSTEM-REMINDER>`;
```

- Update the final fallthrough `reasoning` string:

```ts
reasoning: `Exceeded ${Math.round(budgetMs/1000)}s budget; grace-turn reminder did not yield a valid report_result.`,
```

(h) The block comment at line 374-379 — rewrite to describe the deadline contract instead of the turns contract:

```ts
// Time budget exhausted. The run promised `budgetMs` wall-clock of tool
// access and delivered it. Rather than ending with a generic "exhausted"
// verdict, we inject one final SYSTEM-REMINDER and let the agent call
// report_result with a best-effort summary of where it got stuck and why.
// This extra LLM call does not count against `usage.turns` — the caller
// contract is preserved; the grace turn is overhead.
```

- [ ] **Step 5: Run agent tests — confirm they pass**

Run: `bun test test/agent/agent.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `bun tsc --noEmit`
Expected: errors only in `src/runs/orchestrator.ts` (still passes `maxTurns`) and possibly UI / fixtures. Those are next tasks; leave the errors.

- [ ] **Step 7: Commit**

```bash
git add src/agent/agent.ts test/agent/agent.test.ts
git commit -m "agent: replace turn-counter loop with wall-clock deadline

runAgent now exits when Date.now() >= startTime + budgetMs. AgentOptions
gains required budgetMs and maxStuckRetries; the maxTurns field is gone.
usage.turns still increments per LLM call as an observational counter.
Grace-turn reminder rewritten to talk about time; events renamed
(max_turns_* → deadline_*).

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

---

### Task 4: System-prompt section — stuck-handling

**Goal:** Add a "When to stop" section to the system prompt telling the model what stuckness looks like and what to do about it. Parametrized on `maxStuckRetries`.

**Files:**
- Create: `src/agent/prompts/stuck-handling.md`
- Modify: `src/agent/prompts.ts`
- Modify: `src/agent/agent.ts` (pass `maxStuckRetries` into `buildSystemPrompt`)
- Modify: `test/agent/prompts.test.ts` (if it exists; otherwise no change)

- [ ] **Step 1: Inspect existing prompt structure**

Read `src/agent/prompts.ts` and the existing files in `src/agent/prompts/` (e.g. `persona.md`, `evaluation.md`). Note the loader at `src/agent/prompts/loader.ts` — does it support `{{PLACEHOLDER}}` substitution? Check via `cat src/agent/prompts/loader.ts`. If not, we inline the substitution in `prompts.ts`.

- [ ] **Step 2: Write `stuck-handling.md`**

`src/agent/prompts/stuck-handling.md`:

```markdown
## When to stop

You have a time budget for this run. Keep moving and don't dwell.

If you find yourself trying the same action {{MAX_STUCK_RETRIES}}+ times without making progress — the same selector failing, the same navigation not happening, the same form not advancing — STOP. Call `report_result` with status `investigate` and:

- In `summary`, describe what you were trying to do.
- In `reasoning`, explain where you got stuck.
- Add `observations` (kind: `suggestion`) with concrete recommendations for whoever picks this up.

A run that ends with a clear "stuck on X" report is more valuable than one that burns its time budget hammering at a dead end.
```

- [ ] **Step 3: Wire it into `buildSystemPrompt`**

Edit `src/agent/prompts.ts`. Locate the `buildSystemPrompt` function. Extend the signature:

```ts
export function buildSystemPrompt(
  card: StoryCard,
  contextTree: string | undefined,
  adapterName: string | undefined,
  projectPrompt: string | undefined,
  maxStuckRetries: number,
): string {
```

After the `loadPromptFile("evaluation")` push and before the adapter overlay, insert:

```ts
parts.push(
  loadPromptFile("stuck-handling").replace(
    "{{MAX_STUCK_RETRIES}}",
    String(maxStuckRetries),
  ),
);
```

(Choose where it slots into the prompt order based on the existing flow — after "evaluation" and before the adapter-specific overlay is the natural spot.)

- [ ] **Step 4: Update callers**

Edit `src/agent/agent.ts`. Locate the `buildSystemPrompt(...)` call (around line 121):

```ts
const systemPrompt = buildSystemPrompt(
  card,
  options.contextTree,
  adapter.name,
  options.projectPrompt,
  maxStuckRetries,
);
```

Edit `src/cli/show-prompt.ts` (or whichever caller surfaced via grep). Find `buildSystemPrompt` and pass through the new `maxStuckRetries` — for the introspect renderer, take it from the resolved config's `defaultMaxStuckRetries`.

Run: `grep -rn 'buildSystemPrompt' src/ test/` — touch every call site.

- [ ] **Step 5: Add a focused test for the new prompt section**

If `test/agent/prompts.test.ts` already exists with a baseline-snapshot pattern, regenerate the snapshot with `UPDATE_SNAPSHOTS=1 bun test test/agent/prompts.test.ts` and inspect the diff to confirm the new section landed correctly.

Add a focused unit test (new file `test/agent/stuck-handling-prompt.test.ts`):

```ts
import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "../../src/agent/prompts";
import type { StoryCard } from "../../src/format/story-card";

const CARD: StoryCard = {
  id: "test",
  title: "Test",
  description: "Test card",
  acceptanceCriteria: [],
};

describe("buildSystemPrompt — stuck-handling section", () => {
  test("includes the maxStuckRetries number in the prompt body", () => {
    const prompt = buildSystemPrompt(CARD, undefined, "web", undefined, 5);
    expect(prompt).toContain("trying the same action 5+ times");
    expect(prompt).toContain('Call `report_result` with status `investigate`');
  });

  test("substitutes the maxStuckRetries number", () => {
    const prompt = buildSystemPrompt(CARD, undefined, "web", undefined, 3);
    expect(prompt).toContain("3+ times");
    expect(prompt).not.toContain("{{MAX_STUCK_RETRIES}}");
  });
});
```

- [ ] **Step 6: Run tests**

Run: `bun test test/agent/`
Expected: PASS.

If any prompt-baseline snapshot test exists and now fails, regenerate it deliberately and inspect the diff.

- [ ] **Step 7: Commit**

```bash
git add src/agent/prompts.ts src/agent/prompts/stuck-handling.md src/agent/agent.ts test/agent/
git commit -m "agent: add When-to-stop prompt section steering model to give up gracefully

The model is told to call report_result with status investigate after
maxStuckRetries (default 5) unproductive attempts at the same action,
rather than burning the time budget. Parametrized via {{MAX_STUCK_RETRIES}}
substitution.

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

---

### Task 5: Evidence logger — `run_start` schema swap

**Goal:** Rename `RunStartFields.maxTurns` → `budgetMs`, add `maxStuckRetries`. Update tests that construct `run_start` events.

**Files:**
- Modify: `src/evidence/logger.ts`
- Modify: `test/evidence/logger.test.ts`
- Modify: `test/cli/stream/attach.test.ts`, `test/cli/stream/pretty.test.ts`, `test/cli/batch.test.ts`, `test/ui/transcript.test.ts` (anywhere a `run_start` event is constructed in test code)

- [ ] **Step 1: Edit `src/evidence/logger.ts`**

Locate `RunStartFields` (around line 17). Replace:

```ts
maxTurns: number;
```

with:

```ts
budgetMs: number;
maxStuckRetries: number;
```

- [ ] **Step 2: Find every `run_start` event construction in test code**

Run: `grep -rn 'run_start' test/ | grep -v ".pretty.txt"`

For each location that constructs a `run_start` event literal or calls `logger.logRunStart`, replace `maxTurns: N` with `budgetMs: <N * estimated ms>` and add `maxStuckRetries: 5`. Recommended substitution: `maxTurns: 50` → `budgetMs: 300_000, maxStuckRetries: 5`. (The exact ms value rarely matters for the test; pick the closest analog.)

Specifically:
- `test/evidence/logger.test.ts:137, 268` — `maxTurns: 50` → `budgetMs: 300_000, maxStuckRetries: 5`. The assertion `expect(row.maxTurns).toBe(50)` becomes `expect(row.budgetMs).toBe(300_000)`.
- `test/cli/stream/attach.test.ts:43`
- `test/cli/stream/pretty.test.ts:66, 79, 89`
- `test/cli/batch.test.ts:41, 91, 124, 152, 190, 249`
- `test/ui/transcript.test.ts:248` — the embedded jsonl string `"maxTurns":50` becomes `"budgetMs":300000,"maxStuckRetries":5`. Adjust the test's expectations correspondingly.

- [ ] **Step 3: Run tests for these files**

Run: `bun test test/evidence/logger.test.ts test/cli/stream/ test/cli/batch.test.ts test/ui/transcript.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/evidence/logger.ts test/evidence/logger.test.ts test/cli/stream/ test/cli/batch.test.ts test/ui/transcript.test.ts
git commit -m "evidence: rename run_start.maxTurns to budgetMs + add maxStuckRetries

Schema-breaking change to run.jsonl run_start rows. No external
consumers of the format outside the repo. UI consumer changes follow
in a later commit.

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

---

### Task 6: Orchestrator + RunConfigSnapshot — thread new fields

**Goal:** `src/runs/orchestrator.ts` passes `budgetMs` and `maxStuckRetries` into `AgentOptions`. `RunConfigSnapshot` (in `src/types.ts`) replaces `turns: number` with `budgetMs: number`. `RESULT_SCHEMA_VERSION` bumps from 2 to 3.

**Files:**
- Modify: `src/runs/orchestrator.ts`
- Modify: `src/types.ts`
- Modify: `test/runs/orchestrator.test.ts`

- [ ] **Step 1: Edit `src/types.ts`**

(a) Bump `RESULT_SCHEMA_VERSION` from `2` to `3`.

(b) Update the schema-version comment block at the top of the file:

```ts
// v3: RunConfigSnapshot.turns replaced with budgetMs (wall-clock budget
//     in ms). Reflects the time-budget loop replacing maxTurns. See
//     docs/superpowers/specs/2026-05-11-time-budget-and-stuck-detection-spec.md.
```

(c) Inside `RunConfigSnapshot`, replace `turns: number;` with:

```ts
/** Wall-clock budget in ms that this run was launched with. */
budgetMs: number;
```

- [ ] **Step 2: Edit `src/runs/orchestrator.ts`**

Find the `stampedRunConfig` object (around line 184). Replace `turns: runConfig.turns,` with `budgetMs: runConfig.budgetMs,`.

Find the `runAgent(...)` call (around line 193). Replace `maxTurns: runConfig.turns,` with:

```ts
budgetMs: runConfig.budgetMs,
maxStuckRetries: runConfig.maxStuckRetries,
```

If `runConfig` (the assembled `EffectiveRunConfig` from `mergeRunConfig`) doesn't yet carry `budgetMs`/`maxStuckRetries`, plumb them: update `EffectiveRunConfig` in `src/config.ts` to include `budgetMs: number; maxStuckRetries: number;`, and populate them in `mergeRunConfig`:

```ts
return {
  ...existing fields...,
  budgetMs: app.defaultBudgetMs,
  maxStuckRetries: app.defaultMaxStuckRetries,
};
```

- [ ] **Step 3: Migrate `test/runs/orchestrator.test.ts`**

Find every fixture that creates a run config with `turns: <N>`. Replace with `budgetMs: 600_000, maxStuckRetries: 5`. Update any assertion that reads `result.config.turns`.

- [ ] **Step 4: Run orchestrator tests + type-check**

Run: `bun test test/runs/orchestrator.test.ts`
Expected: PASS.

Run: `bun tsc --noEmit`
Expected: should now have far fewer errors. Remaining errors are in CLI / UI / HTTP route — handled in later tasks.

- [ ] **Step 5: Commit**

```bash
git add src/runs/orchestrator.ts src/types.ts src/config.ts test/runs/orchestrator.test.ts
git commit -m "runs: thread budgetMs+maxStuckRetries through orchestrator and result config

RunConfigSnapshot.turns → budgetMs. RESULT_SCHEMA_VERSION 2 → 3.
EffectiveRunConfig carries budgetMs and maxStuckRetries; mergeRunConfig
populates them from AppConfig defaults.

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

---

### Task 7: CLI — `--turns` out, `--max-time` and `--max-stuck-retries` in

**Goal:** Remove `--turns` from all CLI surfaces. Add `--max-time <duration>` and `--max-stuck-retries <n>`. Update help text. Update arg parsers and `CliArgsInput` plumbing.

**Files:**
- Modify: `src/cli/args.ts`

- [ ] **Step 1: Edit the allow-sets**

In `src/cli/args.ts`:

```ts
const RUN_ALLOWED = new Set([
  "target", "out", "adapter", "model", "chrome", "project-dir",
  "max-time", "max-stuck-retries", "viewport", "save-screencast",
  "silent", "format", "no-color", "passes",
  "project-prompt",
  "show-prompt-and-exit",
]);
// ...
const SERVE_ALLOWED = new Set(["port", "project-dir", "chrome", "target", "model", "max-time", "max-stuck-retries", "viewport", "save-screencast"]);
const CONFIG_ALLOWED = new Set(["json", "project-dir", "port", "chrome", "target", "model", "max-time", "max-stuck-retries", "viewport", "save-screencast"]);
```

Remove `"turns"` everywhere it appears in these sets.

- [ ] **Step 2: Update arg-parser bodies**

Find every `turns: parseIntFlag(flags.turns, "--turns")` and remove it. Replace with:

```ts
maxTime: typeof flags["max-time"] === "string" ? flags["max-time"] : undefined,
maxStuckRetries: parseIntFlag(flags["max-stuck-retries"], "--max-stuck-retries"),
```

For each of the four occurrences (run / run-one / batch / serve flag-builder sites).

- [ ] **Step 3: Update help text**

Locate the four `--turns <n>` help-text lines (around `args.ts:421, 437, 457, 471`). Replace with:

```
    --max-time <duration>   Max wall-clock time per run (default: 5m). Accepts ms/s/m/h suffixes or bare seconds.
    --max-stuck-retries <n> Hint to model: give up after N unproductive retries (default: 5)
```

Remove the `GAUNTLET_TURNS` env var line. Add:

```
  GAUNTLET_MAX_TIME            Default time budget (duration string)
  GAUNTLET_MAX_STUCK_RETRIES   Default stuck-retries hint
```

- [ ] **Step 4: Run all CLI tests + type-check**

Run: `bun test test/cli/`
Expected: PASS (some failures may surface if a test was passing `--turns` via argv; update those tests to pass `--max-time` instead, or just drop the flag).

Run: `bun tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts test/cli/
git commit -m "cli: replace --turns with --max-time and --max-stuck-retries

Removed from RUN_ALLOWED, SERVE_ALLOWED, CONFIG_ALLOWED and all derived
sets. Help text rewritten. GAUNTLET_TURNS env doc replaced with
GAUNTLET_MAX_TIME and GAUNTLET_MAX_STUCK_RETRIES.

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

---

### Task 8: `gauntlet config` output

**Goal:** `src/cli/config-command.ts` prints `defaultBudgetMs` and `defaultMaxStuckRetries` instead of `defaultTurns`/`maxTurnsCap`.

**Files:**
- Modify: `src/cli/config-command.ts`
- Modify: `test/cli/config-command.test.ts` (if it exists — grep first)

- [ ] **Step 1: Edit `src/cli/config-command.ts`**

Locate the output interface and the line-builder logic (around lines 10-99). Replace:

```ts
defaultTurns: number;
maxTurnsCap: number;
```

with:

```ts
defaultBudgetMs: number;
defaultMaxStuckRetries: number;
```

In the JSON-output construction:

```ts
defaultBudgetMs: config.defaultBudgetMs,
defaultMaxStuckRetries: config.defaultMaxStuckRetries,
```

In the human-readable output:

```ts
lines.push(`  defaultBudgetMs:        ${output.gauntlet.defaultBudgetMs}  (${output.gauntlet.sources.defaultBudgetMs})`);
lines.push(`  defaultMaxStuckRetries: ${output.gauntlet.defaultMaxStuckRetries}  (${output.gauntlet.sources.defaultMaxStuckRetries})`);
```

(Remove the `maxTurnsCap` and `defaultTurns` line builders.)

The `sources` block follows the same swap.

- [ ] **Step 2: Run tests**

Run: `bun test test/cli/config-command.test.ts`
Expected: PASS (after updating any assertions that referenced the removed fields). If the test file doesn't exist, skip.

Run by hand: `bun src/index.ts config` — eyeball the output.

- [ ] **Step 3: Commit**

```bash
git add src/cli/config-command.ts test/cli/
git commit -m "cli: gauntlet config emits defaultBudgetMs and defaultMaxStuckRetries

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

---

### Task 9: HTTP route — drop `TurnsTooHighError` handler

**Goal:** `src/api/routes/run.ts` no longer imports or handles `TurnsTooHighError`. The `validateRunBody(...)` call drops the `maxTurnsCap` opts arg. Errors from `validateRunBody` (including the new "turns no longer accepted" rejection) fall through to the generic 400 path.

**Files:**
- Modify: `src/api/routes/run.ts`
- Modify: `test/api/caps.test.ts` (if not already updated in Task 2)

- [ ] **Step 1: Edit `src/api/routes/run.ts`**

Locate the import (around line 12):

```ts
import { mergeRunConfig, validateRunBody, TurnsTooHighError, type AppConfig } from "../../config";
```

Remove `TurnsTooHighError,`.

Locate the route handler (line 183-197). Replace:

```ts
try {
  body = validateRunBody(rawBody, { maxTurnsCap: config.maxTurnsCap });
} catch (err) {
  if (err instanceof TurnsTooHighError) {
    return c.json({
      error: "turns_too_high",
      message: err.message,
      requested: err.requested,
      cap: err.cap,
    }, 400);
  }
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
}
```

with:

```ts
try {
  body = validateRunBody(rawBody, {});
} catch (err) {
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
}
```

- [ ] **Step 2: Verify body.turns is rejected with a 400**

If `test/api/caps.test.ts` doesn't already cover the HTTP-level rejection, add a test that POSTs `{ target: "http://x", turns: 5 }` and expects a 400 with an error message mentioning `turns`. This is the integration counterpart to the unit-level `validateRunBody` test from Task 2.

- [ ] **Step 3: Run tests**

Run: `bun test test/api/`
Expected: PASS.

Run: `bun tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/api/routes/run.ts test/api/
git commit -m "api: drop TurnsTooHighError handler; body.turns rejected at validation

Field is no longer accepted; clients fall back to the daemon's
GAUNTLET_MAX_TIME / --max-time.

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

---

### Task 10: CLI pretty stream — rendering + fixtures

**Goal:** The CLI streaming output replaces `max turns 50` with `max time 5m` in the run_start panel, and drops the `/ N` denominator from the per-turn header so it just reads `turns 1`. Regenerate the golden fixtures.

**Files:**
- Modify: the pretty-stream renderer (locate via grep — likely `src/cli/stream/pretty.ts` or similar).
- Modify: `test/cli/stream/fixtures/happy.pretty.txt`
- Modify: `test/cli/stream/fixtures/failing-tool.pretty.txt`
- Modify: `test/cli/stream/fixtures/fatal.pretty.txt`

- [ ] **Step 1: Locate the renderer**

Run: `grep -rn 'max turns' src/cli/ test/cli/stream/`

There will be one renderer file producing the `max turns N` line and one (probably the same) producing the per-turn header. Read both to understand the formatting.

- [ ] **Step 2: Update the run_start panel**

Replace the `max turns ${maxTurns}` line with a `max time ${humanizeDuration(budgetMs)}` line, where `humanizeDuration` is a small helper that emits `5m` for 300_000, `30s` for 30_000, `1h` for 3_600_000, falling back to `${Math.round(ms/1000)}s` for in-between values. Add `humanizeDuration` next to the renderer (small enough to inline; not worth a separate file).

```ts
function humanizeDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0)    return `${ms / 60_000}m`;
  if (ms % 1_000 === 0)     return `${ms / 1_000}s`;
  return `${ms}ms`;
}
```

- [ ] **Step 3: Update the per-turn header**

Find the line that renders `turns     N / M`. Drop the `/ M`. The header becomes just `turns     N`.

- [ ] **Step 4: Regenerate fixtures**

Each fixture is a checked-in golden file. The test that compares them is in `test/cli/stream/`. To regenerate, either:

(a) Read the test and run it with an `UPDATE_FIXTURES=1` env var if supported, or
(b) Manually edit the three fixture files: replace `  max turns 50` with `  max time 5m`, and any line like `  turns     1 / 50` with `  turns     1`.

Verify the test reads the fixture path correctly:

Run: `bun test test/cli/stream/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/stream/ test/cli/stream/fixtures/
git commit -m "cli/stream: render time budget in run_start; drop turns denominator

run_start panel shows 'max time 5m' instead of 'max turns 50'. Per-turn
header drops the '/ N' denominator since turns is now observational.

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

---

### Task 11: UI — transcript model and API shape

**Goal:** `ui/src/lib/transcript.ts` and `ui/src/lib/api.ts` reflect the new schema. Any component reading `model.maxTurns` is updated.

**Files:**
- Modify: `ui/src/lib/transcript.ts`
- Modify: `ui/src/lib/api.ts`
- Modify: any UI component consuming the renamed fields (grep)

- [ ] **Step 1: Edit `ui/src/lib/transcript.ts`**

Line 21:

```ts
maxTurns: number;
```

→ 

```ts
budgetMs: number;
maxStuckRetries: number;
```

Find every place that constructs a `TranscriptModel` and the reducer that handles `run_start` events. Update field names. The per-turn `turns` Map stays — it's a separate concept.

- [ ] **Step 2: Edit `ui/src/lib/api.ts`**

Lines 25 and 237 (the config snapshot type):

```ts
turns: number;
```

→ 

```ts
budgetMs: number;
```

The `usage.turns` field (line 44) stays untouched — it's observational.

- [ ] **Step 3: Find consumers**

Run: `grep -rn 'maxTurns\|\.turns\b' ui/src/`

Update any component that reads `model.maxTurns` to read `model.budgetMs`. Display formatting (e.g. "max time 5m" vs "max turns 50") is up to the component author; pick the simplest equivalent.

- [ ] **Step 4: Rebuild UI**

Run: `bun run build:ui` (per project memory `project_gauntlet_ui_dist_rebuild.md` — Gauntlet API serves `ui/dist`, not Vite dev).

Run: `bun test test/ui/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/ ui/dist/ test/ui/
git commit -m "ui: rename TranscriptModel.maxTurns to budgetMs; config.turns to budgetMs

Matches the run_start schema change in the agent layer (v3 result schema).

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

---

### Task 12: Full sweep + close-out

**Goal:** Catch any laggard references (e.g. `usage.turns` log-format comments, error messages, dev docs). Run full test suite and type-check. Update Linear to In Review.

- [ ] **Step 1: Final grep sweep**

Run:

```bash
grep -rn -E "(maxTurns|--turns|GAUNTLET_TURNS|defaultTurns|maxTurnsCap|TurnsTooHigh)" src/ test/ ui/src/ docs/ examples/ scripts/ 2>/dev/null | grep -v node_modules | grep -v ".gauntlet/"
```

Expected: zero hits, except possibly the spec file (`docs/superpowers/specs/2026-05-11-time-budget-and-stuck-detection-spec.md`) which is historical documentation and stays as-is.

If any hit remains: fix it in the appropriate task's file and amend its commit, OR (preferred) make a small follow-up commit titled `cleanup: …`.

- [ ] **Step 2: Update `src/types.ts` comment**

The leading comment block that lists "model, adapter, chrome, turns" in describing `RunConfigSnapshot` — update to:

```ts
// v3: RunConfigSnapshot.turns replaced with budgetMs. The config block
//     now captures (target, model, adapter, chrome, budgetMs) for the
//     UI's "Run again" action.
```

- [ ] **Step 3: Full test run**

Run: `bun test`
Expected: PASS (all suites).

Run: `bun tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Smoke test the binary**

Run: `bun src/index.ts --help`
Expected: help text mentions `--max-time` and `--max-stuck-retries`; no `--turns`.

Run: `bun src/index.ts config`
Expected: output shows `defaultBudgetMs: 300000` and `defaultMaxStuckRetries: 5`.

- [ ] **Step 5: Optional — run an actual story**

If a quick fixture story is available locally, run it with `bun src/index.ts run <card> --max-time 30s` to confirm the deadline path works end-to-end.

- [ ] **Step 6: Commit any final tidying**

```bash
git add -A
git commit -m "cleanup: final sweep for stuck-detection + time-budget feature

Co-Authored-By: Brienne (Bob c31c453f/Opus 4.7)"
```

(Skip if there's nothing left.)

- [ ] **Step 7: Move PRI-1557 to In Review and write the reflective comment**

Per `primeradiant-ops:linear-ticket-lifecycle`, transition the ticket and post a comment describing what was smooth, what was tricky, your subjective confidence, and any risk flags for a reviewer.

---

## Self-Review

Spec coverage check:

| Spec section | Covered by |
|---|---|
| Wall-clock budget loop | Task 3 |
| Grace-turn reuse on deadline | Task 3 |
| Stuck-handling prompt | Task 4 |
| Turn count: observational only | Task 3 (loop change) + Task 5 (event field stays) |
| CLI `--max-time`/`--max-stuck-retries` add, `--turns` remove | Task 7 |
| Env `GAUNTLET_MAX_TIME`/`GAUNTLET_MAX_STUCK_RETRIES` | Task 2 |
| HTTP body.turns rejected | Task 2 (validator) + Task 9 (route handler) |
| Config field swap | Task 2 |
| AgentOptions: required `budgetMs`/`maxStuckRetries` | Task 3 |
| `run_start.maxTurns` → `budgetMs` | Task 5 |
| Event renames (`max_turns_*` → `deadline_*`) | Task 3 |
| Pretty stream + fixtures | Task 10 |
| UI consumer updates | Task 11 |
| `RunConfigSnapshot` field swap + schema-version bump | Task 6 |

No placeholder steps. Field-name and method-signature consistency between tasks verified (`budgetMs`, `maxStuckRetries`, `defaultBudgetMs`, `defaultMaxStuckRetries`). Default-value consistency: `5m`/`300_000` and `5` used everywhere. Help-text wording consistent (`Max wall-clock time per run`, `give up after N unproductive retries`).
