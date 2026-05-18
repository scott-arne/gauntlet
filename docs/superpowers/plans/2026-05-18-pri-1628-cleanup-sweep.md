# PRI-1628 — House cleaning sweep — implementation plan

> **For agentic workers:** Execute phase-by-phase. Each phase ends in a green `bun run check` and a commit. Do not skip the verification gates — they're how we catch a slipped invariant before it compounds into the next phase. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Clear the eleven cleanup items in `docs/notes/cleanup-2026-05.md` (treated as the spec for PRI-1628) without breaking any existing behavior or test.

**Architecture:** Seven phases, ordered to do the cheap-and-safe first and the largest refactor last. Every phase leaves the working tree green, so the work can be paused after any phase. No PRs (per house convention) — single feature branch, merged into `main` with `--no-ff` at the end.

**Tech Stack:** TypeScript (strict, ES2022, bundler resolution), Bun 1.3+, Node-compatible. Tests via `bun test`. `bun run check` runs typecheck + UI typecheck + UI build + tests.

**Worktree:** Run on `matt/pri-1628-cleanup-sweep` in a dedicated worktree (memory: `feedback_multi_agent_checkout_collision.md` — shared checkouts can swap branches under you).

---

## Phase 0 — Pre-flight

**Goal:** Establish a green baseline on a clean worktree before any change.

**Heads-up — recent main commits that affect this plan (no action required, just awareness):**

- **PRI-1629 (merge `12fb3b6`)** — restored `bun run typecheck` to green on main + installed pre-commit hook + GitHub Actions workflow. The plan's Phase 0 baseline IS now green; the typecheck failures Cleaver flagged in their earlier session no longer apply.
- **Commit `4d2554f`** (post-PRI-1615 cleanup, "shell-access prompt → .md, drop bash tmpdir fallback") — modifies `src/agent/bash-tool.ts`, all three adapter files (`src/adapters/{cli,tui,web}/adapter.ts`), `src/agent/shared-tools.ts`, `src/agent/prompts.ts`, and `src/agent/prompts/loader.ts`. These overlap by *file* with Task 1.1 (bash-tool), Phase 5 (web adapter split), and Phase 6 (ToolResult DU touches all adapters) — but the changes are at different lines, so `git rebase origin/main` will auto-merge cleanly. No semantic conflicts. Just expect "auto-merging" lines during rebase, not actual conflict markers.

- [ ] **Step 0.1: Create the worktree.**

```bash
cd /Users/mw/Code/prime/gauntlet
git worktree add ../gauntlet-pri-1628 -b matt/pri-1628-cleanup-sweep main
cd ../gauntlet-pri-1628
```

- [ ] **Step 0.2: Install and verify baseline.**

```bash
bun install
bun run check
```

Expected: typecheck passes, ui typecheck passes, ui build succeeds, all tests pass.

If the baseline is not green, **stop**. Investigate before adding new work to a broken tree.

- [ ] **Step 0.3: Record baseline test count.**

```bash
bun test 2>&1 | tail -5
```

Note the number of tests passing. Each phase should match or exceed this number — a phase that *reduces* the test count is suspicious and warrants explicit justification in the commit message.

- [ ] **Step 0.4: Commit nothing yet.** Phase 0 produces no diff. Phase 1 is the first commit.

---

## Phase 1 — Small tidies

**Goal:** Knock out items #6, #8, #9, #10. All low-risk, mechanical, and pay off immediately.

### Task 1.1 — Drop the one truly-dead `*_TOOL_DESCRIPTION` export (item #10, corrected)

**Files:**
- Modify: `src/agent/bash-tool.ts`

**Correction from the original audit:** the audit listed three "dead exports" (`READ_TOOL_DESCRIPTION`, `BASH_TOOL_DESCRIPTION`, `FETCH_CREDENTIAL_TOOL_DESCRIPTION`). Re-verification before dispatch found that two of them are actually used by tests:

- `READ_TOOL_DESCRIPTION` → imported by `test/context/read-tool.test.ts` (line 5)
- `FETCH_CREDENTIAL_TOOL_DESCRIPTION` → imported by `test/context/credential-tool.test.ts` (line 8)

Only `BASH_TOOL_DESCRIPTION` is genuinely unused outside its declaring file. Drop that one export; leave the other two alone. (See the erratum at the top of `docs/notes/cleanup-2026-05.md` for the full story.)

- [ ] **Step 1.1.1: Drop the export from `src/agent/bash-tool.ts`.**

Locate `export const BASH_TOOL_DESCRIPTION = ...` at line 7. Change to `const BASH_TOOL_DESCRIPTION = ...` (drop `export`). Verify it's still used at line 35 in the same file (the tool's `definition` block).

- [ ] **Step 1.1.2: Grep to confirm it's truly dead externally.**

```bash
rg 'BASH_TOOL_DESCRIPTION' src/ test/
```

Expected: matches only inside `src/agent/bash-tool.ts` (the declaration + the one usage).

- [ ] **Step 1.1.3: Run check.**

```bash
bun run check
```

Expected: PASS.

### Task 1.2 — Re-home `ErrorLog` to fix the `cards → api/routes` reach-around (item #8)

**Files:**
- Current: `src/api/routes/errors.ts` — `ErrorLog` is **declared as a class** here (not a type), with `errorRoutes(log)` wiring around it.
- Six production importers verified by `rg`: `api/server.ts`, `api/routes/run.ts`, `api/routes/scenarios.ts`, `api/routes/fanout.ts`, `cards/store.ts`, plus three test files.
- Move target: **`src/util/error-log.ts`** (a neutral leaf — it's a bounded ring-buffer of error records, not card-specific and not route-specific).

**Correction from initial plan:** Earlier wording suggested moving to `cards/`. That would invert the problem — four `api/` modules would then import from `cards/`. `util/` is the neutral home that minimizes new directional dependencies.

- [ ] **Step 1.2.1: Verify the move target is correct.**

```bash
rg -n 'ErrorLog' src/ test/
```

Confirm: `ErrorLog` is a class (not a type), and the importers list above is accurate. If the class has card-specific behavior in methods, the move target may need to be `runtime/` instead — surface to the parent Bob before proceeding.

Also check `test/runs/orchestrator.test.ts` for any structural-import assertion (e.g. `expect(src).not.toContain("ErrorLog")`) — if one exists, the test expectation may need updating.

- [ ] **Step 1.2.2: Move the class to `src/util/error-log.ts`.**

Keep `errorRoutes(log)` (the Hono route factory) in `api/routes/errors.ts` — only `ErrorLog` the class moves. The route factory remains an api/-layer concern; it consumes the now-util-owned type.

- [ ] **Step 1.2.3: Update all six production importers + three test files.**

After updating each, run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 1.2.4: Verify the reach-around is gone.**

```bash
rg "from ['\"].*api/routes" src/cards/ src/util/
```

Expected: zero matches.

### Task 1.3 — Survey action-observer callers; SURFACE the disposition to parent Bob (item #9)

**Files:**
- Investigate only — no code change in Phase 1.
- `src/evidence/logger.ts:150-176` (the two-observer system)
- All callers of `logger.addObserver` (the legacy channel) and `logger.addEventObserver`

This is an architectural decision about active broadcaster wiring, not a refactor. The executor Bob **does not** decide this autonomously.

- [ ] **Step 1.3.1: Find every caller of both observer channels.**

```bash
rg -n 'addObserver|notifyObservers|addEventObserver|notifyEventObservers' src/ test/
```

- [ ] **Step 1.3.2: Write a short surface-up note.**

Append to the bottom of the plan file (`docs/superpowers/plans/2026-05-18-pri-1628-cleanup-sweep.md`) a section `## Action-observer survey (Phase 1 deferral)` with:
  - List of every caller of `addObserver`, with one-line "what shape does it consume."
  - List of every caller of `addEventObserver`.
  - One-sentence recommendation: retire OR rename, with justification.

- [ ] **Step 1.3.3: Commit the survey as a doc-only change, then stop on this task.**

```bash
git add docs/superpowers/plans/2026-05-18-pri-1628-cleanup-sweep.md
git commit -m "docs: action-observer caller survey for PRI-1628 phase 1 (decision pending)"
```

**Do not apply the decision.** Susan reviews the survey at the end of Phase 1 and either: (a) approves the recommendation, executor applies in a follow-up commit; or (b) defers Item #9 entirely to a future ticket.

### Task 1.4 — DEFERRED (item #6 dropped from scope)

**Status: deferred to a future ticket.**

Reviewer (Skeptic@852ae4d6) flagged that `runDir` and `outDir` are not pure synonyms in the source. `src/runs/orchestrator.ts:187` deliberately remaps `runDir: outDir,` — the *caller's parameter* (`outDir`, "where to put results") becomes the *interior name* (`runDir`, "the path once committed") at module boundaries. The same pattern shows up in `src/runs/snapshot.ts` (`SnapshotOpts.runDir` is documented contract) and `src/revival/rebuild-messages.ts` (`rebuildMessages(runDir, ...)` is part of the revival API).

A blanket rename would touch ~200 call sites and rewrite stable interface field names for low leverage (Item #6 was already rated lowest-priority in the assessment doc).

**Out of scope for PRI-1628.** Leave the names as they are.

### Phase 1 wrap-up

Phase 1 commits land as separate units (Tasks 1.1, 1.2, 1.3 — Task 1.4 is deferred). The action-observer survey (1.3) is a doc-only commit and explicitly pauses for Susan's review before applying any change.

- [ ] **Step 1.5: Tag the phase boundary for rollback.**

```bash
git tag pri-1628-phase-1
```

- [ ] **Step 1.6: Rebase from main before starting Phase 2.**

```bash
git fetch origin main
git rebase origin/main
```

If conflicts appear, resolve them and re-tag. The cleanup sweep is multi-day; main moves; concentrate the rebase pain at phase boundaries, not at the final merge.

**Commit attribution.** Every commit in this plan uses `Co-Authored-By: <YourBobName>@<first8hex> (Opus 4.7)` — where `<YourBobName>@<first8hex>` is the executor Bob's handle from SCUT registration. Substitute your real handle every time; do not commit the literal placeholder string.

---

## Phase 2 — Type-level safe wins

**Goal:** Items #1, #3, #5. Type-only changes; the compiler catches everything; existing tests guard the runtime contract.

**Order:** 2.1 (config collapse) → 2.2 (VetResult DU) → 2.3 (brands). **Brands last.** Brands harvested as a follow-on signal after the shapes settle. If we brand first, every later task's type-error surface doubles because every signature with `runId: string` becomes `runId: RunId` and every later refactor inherits the brand-mismatch noise.

### Task 2.1 — Collapse run-config triplication (item #1)

**Strategy:** Make `RunCoreConfig` and `EffectiveRunConfig` one type — call it `ResolvedRunConfig`. `RunConfigSnapshot` stays distinct (it's a versioned wire format) but is *derived* from `ResolvedRunConfig` via an explicit `snapshotRunConfig()` function so the field set is single-sourced.

**Files:**
- Modify: `src/config.ts` — drop `EffectiveRunConfig`, export `ResolvedRunConfig`
- Modify: `src/runs/orchestrator.ts` — drop `RunCoreConfig`, use `ResolvedRunConfig`
- Modify: `src/types.ts` — add `snapshotRunConfig(rc: ResolvedRunConfig): RunConfigSnapshot`
- Modify: `src/cli/run.ts`, `src/cli/batch.ts`, `src/api/routes/run.ts` — call sites

- [ ] **Step 2.1.1: Read the three current types side-by-side.**

```bash
rg -n 'EffectiveRunConfig|RunCoreConfig|RunConfigSnapshot' src/ | head -40
```

- [ ] **Step 2.1.2: Define `ResolvedRunConfig` in `src/config.ts`.**

It is `EffectiveRunConfig`'s exact field set today (target, model, chrome, adapter, viewport, saveScreencast, projectRoot, budgetMs, reflectionInterval, credentialResolver).

- [ ] **Step 2.1.3: Delete `RunCoreConfig` from `src/runs/orchestrator.ts`.**

Every place it appeared, use `ResolvedRunConfig`. The `saveScreencast` field is now reachable from the orchestrator — investigate whether the orchestrator should also honor it (likely yes, but verify against current behavior; if the wrapper handles screencast persistence today, leave the wiring alone).

- [ ] **Step 2.1.4: Rename `EffectiveRunConfig` → `ResolvedRunConfig` in `src/config.ts` and all imports.**

- [ ] **Step 2.1.5: Add `snapshotRunConfig` in `src/types.ts`.**

```ts
export function snapshotRunConfig(rc: ResolvedRunConfig, viewport: Viewport | undefined): RunConfigSnapshot {
  return {
    target: rc.target,
    model: rc.model,
    adapter: rc.adapter,
    chrome: rc.chrome ? `${rc.chrome.host}:${rc.chrome.port}` : undefined,
    budgetMs: rc.budgetMs,
    viewport,
  };
}
```

Note that `viewport` is passed in separately because the *snapshot* viewport comes from the started adapter (`snapshotViewport(adapter)`), not the config. Keep this seam explicit.

- [ ] **Step 2.1.6: Update orchestrator to use `snapshotRunConfig` instead of the inline object literal.**

Look at `src/runs/orchestrator.ts:218-225` — the `stampedRunConfig` object literal. Replace with `snapshotRunConfig(runConfig, snapshotViewport(adapter))`.

- [ ] **Step 2.1.7: Run check.**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 2.1.8: Commit Task 2.1.**

```bash
git commit -am "refactor: collapse EffectiveRunConfig + RunCoreConfig → ResolvedRunConfig (PRI-1628 phase 2)

Three near-identical run-config types reduced to two: ResolvedRunConfig
(internal, post-merge) and RunConfigSnapshot (wire format, versioned).
Snapshot is now derived from resolved via snapshotRunConfig() so the
field set is single-sourced."
```

### Task 2.2 — `VetResult` → discriminated union on `status` (item #3)

**Files:**
- Modify: `src/types.ts` — `VetResult` becomes a DU
- Modify: `src/agent/agent.ts` — the `buildResult` helper needs to construct each variant correctly

**Schema-version question:** This is a TS-only narrowing. The JSON on disk is unchanged (an "errored" result already has an `error` field; a "pass" result already omits it). Therefore **do not bump `RESULT_SCHEMA_VERSION`** — there is no wire-format change.

- [ ] **Step 2.2.1: Convert `VetResult` to a DU.**

```ts
interface VetResultBase {
  schemaVersion: number;
  runId: RunId;
  scenario: CardId;
  summary: string;
  reasoning: string;
  observations: Observation[];
  evidence: { /* ... */ };
  duration_ms: number;
  usage?: { /* ... */ };
  config?: RunConfigSnapshot;
  runSet?: RunSetCtx;
}

export type VetResult =
  | (VetResultBase & { status: "pass" | "fail" | "investigate" })
  | (VetResultBase & { status: "errored"; error: { type: string; message: string } });
```

- [ ] **Step 2.2.2: Fix `agent.ts:buildResult`.**

The current helper takes an optional `error?` field. After the DU, callers either pass a status in `"pass" | "fail" | "investigate"` (no `error`) or `"errored"` (with `error`). Adjust the helper signature to enforce this — likely two overloads, or a single signature with a conditional type, whichever is clearer.

- [ ] **Step 2.2.3: Fix any downstream consumer.**

The revival path, the result writer, the run-set aggregator, the UI types — each may read `result.error` directly. After the DU, they need a narrowing check: `if (result.status === "errored") { result.error /* … */ }`.

Compiler will find these.

- [ ] **Step 2.2.4: Run check.**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 2.2.5: Commit Task 2.2.**

```bash
git commit -am "refactor: VetResult → discriminated union on status (PRI-1628 phase 2)

result.error is now compiler-enforced as present iff status === \"errored\".
JSON wire format unchanged — no RESULT_SCHEMA_VERSION bump."
```

### Task 2.3 — Brand `RunId`, `CardId`, `RunSetId` (item #5) — LAST in Phase 2

**Strategy:** Brand at central type declarations and at id-construction helpers. Accept that bare `string` flows through internal helpers — brands only earn their keep when **boundary asserts** are explicit and **interior types** are brand-typed.

**The four genuine boundary classes** (these are the *only* places where `asRunId(...)` / `asCardId(...)` / `asRunSetId(...)` may appear in `src/`):

1. **HTTP route handler param extraction** — e.g. `c.req.param("runId")` returns `string`, brand at the call site.
2. **Disk reads** (`JSON.parse(readFileSync(...))` of `result.json`, snapshots, etc.) — brand at the parse boundary.
3. **CLI args** parsed in `cli/args.ts` — brand at the parser output.
4. **`makeRunId` / `makeCardId` / `makeRunSetId` return types** themselves declared as the brand.

**Forbidden:** `asRunId()` inside trusted internal code (cross-module helper calls within the daemon). If the compiler is asking you to do that, the type on the *caller* needs widening or the type on the *callee* needs narrowing — not a cast.

**Expected error volume.** Skeptic's spot-check counted ~150 references to `runId` alone in src/+test. The realistic cap after applying boundary discipline is **probably 50–80 type errors** during migration, not the ~30 the earlier draft of this plan suggested. Don't panic at 60.

**Files:**
- Create: `src/util/brands.ts` (or place in `src/types.ts` if you prefer central) — declare brand types + boundary helpers
- Modify: `src/util/id.ts` — `makeRunId` returns `RunId`
- Modify: `src/types.ts`, `src/runs/run-set-types.ts`, `src/format/story-card.ts`, `src/evidence/logger.ts`, `src/agent/agent.ts` — field declarations
- Modify: HTTP route handlers in `src/api/routes/*.ts` — boundary `asRunId(...)` at param extraction
- Modify: CLI arg parsing in `src/cli/args.ts` — boundary `asRunId(...)` at runId-bearing arg

- [ ] **Step 2.3.1: Declare brand types.**

```ts
// src/util/brands.ts
declare const RunIdBrand: unique symbol;
export type RunId = string & { readonly [RunIdBrand]: true };

declare const CardIdBrand: unique symbol;
export type CardId = string & { readonly [CardIdBrand]: true };

declare const RunSetIdBrand: unique symbol;
export type RunSetId = string & { readonly [RunSetIdBrand]: true };

export const asRunId = (s: string): RunId => s as RunId;
export const asCardId = (s: string): CardId => s as CardId;
export const asRunSetId = (s: string): RunSetId => s as RunSetId;
```

- [ ] **Step 2.3.2: Update id-construction helpers in `src/util/id.ts`.**

`makeRunId` returns `RunId`. Any other id constructors return their brand.

- [ ] **Step 2.3.3: Brand the field declarations.**

In `VetResult.runId`, `VetResult.scenario` (verify `scenario` is the cardId field), `StoryCard.id`, `RunSetCtx.runSetId`, logger field types — switch from `string` to the branded type.

- [ ] **Step 2.3.4: Fix the resulting type errors at the four boundary classes only.**

Run `bun run typecheck`. For each error, classify:
- **Boundary** (one of the four classes above): add `asRunId(...)`.
- **Interior**: the caller already has a `RunId` in scope and is feeding it to something typed `string`, or vice versa. Fix the *type*, not the call site.

Re-read the forbidden constraint above before adding any `asRunId(...)` call.

- [ ] **Step 2.3.5: Run check.**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 2.3.6: Audit the boundary discipline.**

```bash
rg -n 'asRunId|asCardId|asRunSetId' src/ | wc -l
```

Expected: roughly 15–25 call sites in `src/`. If substantially more (say >40), the boundary discipline slipped — surface to the parent Bob before committing.

- [ ] **Step 2.3.7: Commit Task 2.3.**

```bash
git commit -am "refactor: brand RunId, CardId, RunSetId (PRI-1628 phase 2)

Three identifiers flowed as bare strings through many layers — easy to
transpose at a callsite. Brand at central type declarations and id
constructors; asRunId/asCardId/asRunSetId restricted to four boundary
classes (HTTP route params, disk reads, CLI args, id-constructor returns)."
```

### Phase 2 wrap-up

- [ ] **Step 2.4: Tag the phase boundary.**

```bash
git tag pri-1628-phase-2
git fetch origin main && git rebase origin/main
```

---

## Phase 3 — Error-style consolidation (item #4)

**Goal:** Pick one error-handling style, document it, migrate the stragglers.

**Files:**
- Document: `CONTRIBUTING.md` or `docs/architecture/error-handling.md` (decide one home)
- Audit: `src/api/routes/*.ts` for `{ error: string }` returns
- Audit: any `try/catch` that should be a `ParseResult`

### Task 3.1 — Document the rule

- [ ] **Step 3.1.1: Decide home for the doc.**

If a `CONTRIBUTING.md` exists at the repo root or `docs/`, add a section there. If not, create `docs/architecture/error-handling.md`.

- [ ] **Step 3.1.2: Write the rule.**

The recommended policy (from the assessment doc):

> **Expected failures use `ParseResult<T>`.** Anything where failure is a normal outcome — parsing, validation, lookups, optional credential fetches — returns `{ ok: true, value: T } | { ok: false, reason: string }`. Use the `ParseResult<T>` shape from `src/agent/validators.ts`.
>
> **Exceptional failures throw.** Disk I/O, network failures, programmer errors, anything the caller cannot meaningfully recover from. Catch at process boundaries (route handlers, CLI dispatchers) and convert to a clean exit / error response.
>
> **The `{ error: string }` discriminated-union shape is retired** for new code. Existing usage migrates to `ParseResult` in Phase 3.

- [ ] **Step 3.1.3: Commit the doc.**

```bash
git add docs/architecture/error-handling.md   # or CONTRIBUTING.md
git commit -m "docs: error-handling policy — ParseResult for expected, throw for exceptional (PRI-1628 phase 3)"
```

### Task 3.2 — Migrate `{ error: string }` returns

**Known site:** `src/api/routes/fanout.ts:14` — `resolveClient` returns `LLMClient | { error: string }`.

- [ ] **Step 3.2.1: Find all sites.**

```bash
rg -n '\| \{ error:' src/
rg -n '"error" in ' src/
```

- [ ] **Step 3.2.2: Convert each to `ParseResult<T>`.**

For `resolveClient`:

```ts
// Before:
function resolveClient(...): LLMClient | { error: string } { ... }
// After:
function resolveClient(...): ParseResult<LLMClient> { ... }
// Caller before:
if ("error" in clientOrError) return c.json({ error: clientOrError.error }, 400);
// Caller after:
if (!resolved.ok) return c.json({ error: resolved.reason }, 400);
```

The JSON response shape (`{ error: "..." }`) stays the same — that's the HTTP wire format, separate concern.

- [ ] **Step 3.2.3: Run check.**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 3.2.4: Commit Phase 3.**

```bash
git commit -am "refactor: migrate { error: string } returns to ParseResult (PRI-1628 phase 3)"
```

---

## Phase 4 — Config-parser combinator (item #2)

**Goal:** Replace ~15 hand-rolled env+flag+default+source blocks in `src/config.ts` with a single `resolveSetting<T>` helper. Preserve `AppConfig.sources` byte-for-byte — `mergeRunConfig` reads `sources.defaultChrome === "default"` to decide whether to auto-launch Chrome, and several other source attributions feed `gauntlet config`.

### Task 4.1 — Design the helper

**Files:**
- Create: `src/config-helpers.ts` (or add to `src/config.ts` itself — judgment call; if it grows large, split it out)

- [ ] **Step 4.1.1: Write the helper.**

The helper must handle three source-union shapes that exist in `AppConfig.sources` today:
- `"default" | "env" | "flag"` (most knobs)
- `"default" | "env"` (env-only operator knobs: `shutdownGraceMs`, `maxRequestBodySize`, `maxConcurrentRuns`, `activeRunTargetMaxBytes`, `wsIdleTimeoutSec`, `wsOriginAllowlist`, `models.available`)
- `"default" | "env" | "flag" | "unset"` (`defaultTarget`, `models.fanout` — values start as "unset" rather than "default" because there's no in-code default)

A single generic helper handles all three by letting the caller specify the "no value present" source value:

```ts
// src/config-helpers.ts
export type SettingSource = "default" | "env" | "flag";

export interface SettingSpec<T, NoVal extends string = "default"> {
  default: T;
  /** Source string used when neither env nor arg provided a value. Defaults
   * to "default"; pass "unset" for knobs that have no in-code default
   * (defaultTarget, models.fanout). */
  noValueSource?: NoVal;
  env?: { name: string; parse: (raw: string) => T };
  arg?: { value: T | undefined };
}

export interface Resolved<T, NoVal extends string = "default"> {
  value: T;
  source: NoVal | "env" | "flag";
}

export function resolveSetting<T, NoVal extends string = "default">(
  spec: SettingSpec<T, NoVal>,
  envBag: NodeJS.ProcessEnv,
): Resolved<T, NoVal> {
  let value = spec.default;
  let source: NoVal | "env" | "flag" = (spec.noValueSource ?? ("default" as NoVal));
  if (spec.env) {
    const raw = envBag[spec.env.name];
    if (raw !== undefined && raw !== "") {
      value = spec.env.parse(raw);
      source = "env";
    }
  }
  if (spec.arg && spec.arg.value !== undefined) {
    value = spec.arg.value;
    source = "flag";
  }
  return { value, source };
}
```

**For the `"unset"` knobs** (`defaultTarget`, `models.fanout`): `default` is `undefined` (typed as `T | undefined`), `noValueSource: "unset"`. The TS inference picks up the narrower source union via the generic.

**For env-only knobs:** omit the `arg` field. The source union returned is still `NoVal | "env" | "flag"` typewise — accept a small over-typing here, since `"flag"` is unreachable when `arg` is omitted. If you'd rather have an exact-narrowing helper, add a sibling `resolveEnvOnlySetting<T>` whose return is `{ value: T; source: "default" | "env" }`, but **decide before migrating any block**, not mid-Phase 4.

- [ ] **Step 4.1.1a: Write a regression test for `mergeRunConfig`'s source attribution BEFORE touching `config.ts`.**

`test/config/source-attribution.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { loadConfig, mergeRunConfig } from "../../src/config";

describe("source attribution (load-bearing for mergeRunConfig)", () => {
  it("sources.defaultChrome === 'default' when env+args empty", () => {
    const config = loadConfig({}, {});
    expect(config.sources.defaultChrome).toBe("default");
  });

  it("mergeRunConfig leaves chrome undefined when source is default and body has no chrome", () => {
    const config = loadConfig({}, {});
    const merged = mergeRunConfig(config, { target: "http://example.com" });
    expect(merged.chrome).toBeUndefined();
  });

  it("mergeRunConfig honors env-sourced chrome", () => {
    const config = loadConfig({}, { GAUNTLET_CHROME: "127.0.0.1:9333" } as any);
    const merged = mergeRunConfig(config, { target: "http://example.com" });
    expect(merged.chrome).toEqual({ host: "127.0.0.1", port: 9333 });
  });

  it("sources.defaultTarget === 'unset' when nothing sets it", () => {
    const config = loadConfig({}, {});
    expect(config.sources.defaultTarget).toBe("unset");
  });
});
```

```bash
bun test test/config/source-attribution.test.ts
```

Expected: PASS (against the **current** hand-rolled implementation, before any migration). This test is the safety net for Phase 4 — if it stays green through all 17 block migrations, the source-attribution invariants are preserved.

- [ ] **Step 4.1.2: Write a focused test for the helper.**

`test/config/resolve-setting.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { resolveSetting, resolveEnvOnlySetting } from "../../src/config-helpers";

describe("resolveSetting", () => {
  it("returns default when neither env nor arg present", () => {
    const r = resolveSetting({ default: 42 }, {});
    expect(r).toEqual({ value: 42, source: "default" });
  });
  it("returns env when set", () => {
    const r = resolveSetting({
      default: 42,
      env: { name: "FOO", parse: (s) => parseInt(s, 10) },
    }, { FOO: "7" });
    expect(r).toEqual({ value: 7, source: "env" });
  });
  it("returns arg when provided (overrides env)", () => {
    const r = resolveSetting({
      default: 42,
      env: { name: "FOO", parse: (s) => parseInt(s, 10) },
      arg: { value: 9 },
    }, { FOO: "7" });
    expect(r).toEqual({ value: 9, source: "flag" });
  });
  it("ignores empty-string env (treats as unset)", () => {
    const r = resolveSetting({
      default: 42,
      env: { name: "FOO", parse: (s) => parseInt(s, 10) },
    }, { FOO: "" });
    expect(r).toEqual({ value: 42, source: "default" });
  });
});
```

- [ ] **Step 4.1.3: Run the test.**

```bash
bun test test/config/resolve-setting.test.ts
```

Expected: PASS.

### Task 4.2 — Migrate `config.ts` block-by-block

Each migration replaces one of the ~15 hand-rolled blocks with one `resolveSetting` call. Migrate in order, run `bun run check` after each block, **commit after each migration** so any regression is bisected to one block.

Order (cheapest first):
1. `projectRoot`
2. `port`
3. `defaultChrome` (note: parser is non-trivial — `parseChromeEndpoint`)
4. `defaultTarget` (note: source type is `"default" | "env" | "flag" | "unset"` — wider than the helper's default; will need a small adapter)
5. `defaultViewport`
6. `defaultSaveScreencast`
7. `defaultBudgetMs` (uses `parseDuration`)
8. `defaultReflectionInterval`
9. `shutdownGraceMs` (env-only)
10. `maxRequestBodySize` (env-only)
11. `maxConcurrentRuns` (env-only)
12. `activeRunTargetMaxBytes` (env-only)
13. `wsIdleTimeoutSec` (env-only)
14. `wsOriginAllowlist` (env-only; parser produces a list)
15. `models.agent`
16. `models.fanout` (source narrows to include `"unset"`)
17. `models.available` (env-only)

- [ ] **Step 4.2.1: Migrate the first block (`projectRoot`).**

```bash
bun run check
git commit -am "refactor(config): migrate projectRoot to resolveSetting (PRI-1628 phase 4)"
```

- [ ] **Step 4.2.2 through 4.2.17: Migrate remaining blocks one at a time, committing each.**

For each:
1. Replace the block.
2. `bun run check`.
3. Commit.

Skip a block if migration would lose source-attribution fidelity (e.g. `defaultTarget` has an `"unset"` source not in the helper's union). Either generalize the helper once across all such cases at the end, or leave the holdouts hand-rolled and document why in a comment.

### Task 4.3 — Phase 4 wrap-up

- [ ] **Step 4.3.1: Verify line count reduction.**

```bash
wc -l src/config.ts
```

Expected: substantially smaller. If `config.ts` did not shrink by ≥200 lines, the migration probably duplicated the helper rather than collapsing the blocks.

- [ ] **Step 4.3.2: Final check.**

```bash
bun run check
```

Expected: PASS.

---

## Phase 5 — Web adapter split (item #7)

**Goal:** `src/adapters/web/adapter.ts` is 1257 LOC. The `web/lib/` subdirectory already exists (`passkey.ts`, `cookies.ts`, `page-scripts/`). Extend the pattern: move per-capability code out of the adapter into `web/lib/`.

This is the largest refactor in the sweep. Allocate generous time. **If a phase boundary is needed for a session change, end the phase here and resume.**

### Task 5.1 — Survey the adapter and propose the split as a doc-only commit

- [ ] **Step 5.1.1: Read `src/adapters/web/adapter.ts` end-to-end.**

Identify natural capability boundaries. Likely candidates:
- Construction + lifecycle (start, close, profile-dir handling)
- Tool definitions + tool dispatch (a large switch on tool name)
- Per-tool implementations (click, navigate, screenshot, type, wait_for, …)
- Screencast wiring (frame piping)
- Chrome attach / auto-launch

- [ ] **Step 5.1.2: Write the proposed split as `docs/superpowers/plans/2026-05-18-pri-1628-web-adapter-split.md`.**

Cover:
- Proposed new files under `src/adapters/web/lib/`
- For each file: the public surface (exported functions/types), expected LOC bound
- The shape of `adapter.ts` after the split (the facade — what stays)
- Estimated final LOC for each file

- [ ] **Step 5.1.3: Commit the proposal as a DOC-ONLY commit and STOP.**

```bash
git add docs/superpowers/plans/2026-05-18-pri-1628-web-adapter-split.md
git commit -m "docs: web-adapter split proposal for PRI-1628 phase 5 (review gate)"
```

**This is a hard gate.** Susan (the parent Bob) reviews the proposal and either approves, requests changes, or defers Phase 5 to a future ticket. The executor Bob does not move any code under `adapters/web/` until the proposal is reviewed.

### Task 5.2 — Move code out, one capability at a time

For each capability:

- [ ] **Step 5.2.N: Create the new file under `src/adapters/web/lib/`.**

Move the function(s). Keep the import surface tight. The capability file should depend on `web/lib/*` and Node/CDP libraries only, not on `adapter.ts` itself.

- [ ] **Step 5.2.N+1: Update `adapter.ts` to import the moved capability.**

The adapter shrinks; the capability now lives next to its siblings.

- [ ] **Step 5.2.N+2: Run check + commit.**

```bash
bun run check
git commit -am "refactor(web-adapter): extract <capability> to web/lib/<file>.ts (PRI-1628 phase 5)"
```

**Acceptance for this task:** `src/adapters/web/adapter.ts` shrinks to ≤500 LOC. If it stays larger, something significant has not been split; surface to the parent Bob.

---

## Phase 6 — `ToolResult` discriminated union (item #11)

**Goal:** `ToolResult` today has `text: string` plus six optional fields. Real shape is roughly 3–4 variants. Convert to a DU; the compiler will catch the `as any` casts in `agent.ts:397-400`.

### Task 6.1 — Identify the variants

**Files:**
- Modify: `src/models/provider.ts` — `ToolResult` definition
- Modify: `src/adapters/{web,cli,tui}/adapter.ts` — all `ToolResult` construction sites
- Modify: `src/agent/agent.ts:logToolResult` call site — drop the `as any` casts

- [ ] **Step 6.1.1: Survey every `ToolResult` construction site.**

A regex on `return { ... text: }` will miss multi-line object literals (most of them). Better:

```bash
# Find every function declared as returning ToolResult or Promise<ToolResult>:
rg -n ': ToolResult\b|Promise<ToolResult>' src/adapters/ src/agent/ src/context/

# Then for each producer, read it in full to see which optional fields cluster.
```

If a TS-aware tool is available (e.g. `tsc --listFiles` with a script, or the LSP), prefer it. The cheapest correct approach is to find every producer file via the type signature, then read each file and tally manually. There aren't many — ~10–15 producers across the codebase.

For each site, note which optional fields are set together. That clusters into variants.

- [ ] **Step 6.1.2: Sketch the DU.**

Likely shape (refine after the survey):

```ts
export type ToolResult =
  | { kind: "text"; text: string; transcriptText?: string }
  | { kind: "image"; text: string; image: { data: string; mediaType: string }; imagePath?: string }
  | { kind: "artifact"; text: string; artifactPath: string }
  | { kind: "capture"; text: string; capturePath: string };
```

The `text` field stays universal (it's what the LLM sees on its next turn — every variant has it). The variants differ in *what else* is recorded.

If the survey shows the variants aren't this clean, regroup and propose a refined cut.

- [ ] **Step 6.1.3: Apply the DU.**

Update `ToolResult` in `provider.ts`. Then `bun run typecheck` and fix each error — each is either a construction site that needs a `kind` or a consumer that needs to narrow.

The casts in `agent.ts:397-400` (`(result as any).imagePath`, `.image?.mediaType`, `.artifactPath`, `.capturePath`) should now compile cleanly via `result.kind === "image"` etc. narrowing.

- [ ] **Step 6.1.4: Run check.**

```bash
bun run check
```

Expected: PASS, and the four `as any` casts in `agent.ts` are gone.

- [ ] **Step 6.1.5: Commit Phase 6.**

```bash
git commit -am "refactor: ToolResult → discriminated union on kind (PRI-1628 phase 6)

Eliminates the four `as any` casts in agent.ts:397-400 that accessed
imagePath / image.mediaType / artifactPath / capturePath. The wire
format (run.jsonl tool_result rows) is unchanged — those rows already
match the variant shapes implicitly."
```

---

## Phase 7 — Wrap-up

- [ ] **Step 7.1: Final `bun run check`.**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 7.2: Verify the negative-assertion matrix in one block.**

```bash
echo "=== Phase 1 assertions ==="
rg -c 'TOOL_DESCRIPTION\b' src/

echo "=== Phase 2 assertions ==="
rg -c 'EffectiveRunConfig|RunCoreConfig' src/
rg -c 'asRunId|asCardId|asRunSetId' src/

echo "=== Phase 3 assertions ==="
rg -c '\| \{ error:' src/
rg -c '"error" in ' src/

echo "=== Phase 4 assertions ==="
wc -l src/config.ts

echo "=== Phase 6 assertions ==="
rg -c 'as any' src/agent/agent.ts

echo "=== Test count vs baseline ==="
bun test 2>&1 | tail -3
```

Compare each output against the verification matrix. Any deviation is a real signal — either a missed migration or an unintended regression.

- [ ] **Step 7.3: Verify the phase-boundary tags exist.**

```bash
git tag | rg 'pri-1628-phase-'
```

Expected: `pri-1628-phase-1` through `pri-1628-phase-6` (phase 7 has no tag — this *is* phase 7).

- [ ] **Step 7.4: Re-read the assessment doc against the diff.**

```bash
git log --oneline main..HEAD
```

For each of the 11 items in `docs/notes/cleanup-2026-05.md`, confirm there's a commit that addresses it. **Item #6 is deferred** per Skeptic's review — note that in the Linear comment. Any other deferral should also be called out with a one-line reason.

- [ ] **Step 7.5: Move Linear ticket to In Review with a reflective comment.**

Per the `linear-ticket-lifecycle` skill, transition PRI-1628 to In Review and post a reflective comment. The comment should cover: what went smoothly, what was tricky, subjective experience, anything a reviewer should watch.

- [ ] **Step 7.6: Do NOT merge. Do NOT close.**

Per house convention (`feedback_no_prs.md` + `feedback_linear_never_close_tickets.md`):
- No PRs. Susan / the human merges the feature branch to `main` with `--no-ff` after In Review.
- The executor Bob never transitions PRI-1628 to Done / Canceled / Duplicate. In Review is the executor's last move.

---

## Verification matrix

Negative-assertion grep queries are the proof; `bun run check` green is necessary but not sufficient (a phase can land "passing" while skipping its actual job).

| Phase | Negative assertion | Positive assertion |
|-------|--------------------|--------------------|
| 1 | `rg -c 'TOOL_DESCRIPTION\b' src/` ≤ 3 (only the three known declaration sites) | action-observer survey doc committed; `ErrorLog` resides in `src/util/` |
| 2 | `rg -c 'EffectiveRunConfig\|RunCoreConfig' src/` returns 0 | `RunId`, `CardId`, `RunSetId` exported from `src/util/brands.ts`; `rg -c 'asRunId\|asCardId\|asRunSetId' src/` between 15 and 40 |
| 3 | `rg -c '\\| \\{ error:' src/` returns 0; `rg -c '"error" in ' src/` returns 0 | error-handling policy doc exists at agreed path |
| 4 | hand-rolled blocks gone: `rg -c 'Source: "default" \\| "env"' src/config.ts` returns 0 | `wc -l src/config.ts` ≥ 200 lower than baseline; `source-attribution.test.ts` green |
| 5 | (gated; see Task 5.1) | no single file under `src/adapters/web/` exceeds 500 LOC; total LOC across `web/` may grow |
| 6 | `rg -c 'as any' src/agent/agent.ts` returns 0 (currently 4) | `ToolResult` is a DU on `kind` field |
| 7 | test count `>= ` baseline recorded in Phase 0 | Linear In Review with reflective comment; tags `pri-1628-phase-1` through `pri-1628-phase-6` exist |

## Risks and watch-points

- **Phase 2 brands (Task 2.3)**: easy to over-brand. The boundary discipline in Task 2.3 spells out the four allowed boundary classes; respect it. Realistic post-brand type-error count is **50–80**, not the ~30 the earlier draft suggested. Don't panic at 60. If error count exceeds 100, the cut is too aggressive — pull back to a narrower field-level brand set and surface.
- **Phase 4 source attribution**: handled directly via Step 4.1.1a's regression test. The test runs BEFORE any migration and stays green through all 17 block migrations. If it ever goes red mid-Phase 4, the offending block's migration is wrong.
- **Phase 5 web adapter**: gated by Task 5.1.3 — the proposal lands as a doc-only commit before any code moves. Susan reviews and approves the split before extraction work begins. Run the web-adapter test suite (`bun test test/adapters/web`) after each extraction; if any test starts behaving differently (e.g. timing-sensitive flakes appear), pause and surface.
- **Branch hygiene**: each phase ends with `git tag pri-1628-phase-N` (rollback unit) and `git fetch origin main && git rebase origin/main` (concentrate rebase pain at phase boundaries, not at final merge).
- **Memory cues**:
  - `feedback_multi_agent_checkout_collision.md` — the executor Bob works on the worktree, not the main checkout. Verify `git branch --show-current` matches the expected branch before each commit.
  - `feedback_no_prs.md` — no PRs. Phase 7 hands off at Linear In Review; Susan / the human merge to `main` with `--no-ff`.
  - `feedback_linear_never_close_tickets.md` — the executor never transitions PRI-1628 to a terminal state. In Review is the executor's last move.
- **`bun run check` runtime**: Phase 4 runs `bun run check` ~17 times across the block migrations. Each `check` runs typecheck + UI typecheck + UI build + tests. If `check` runtime exceeds ~60s on this machine, consider running only `bun run typecheck` between blocks and `bun run check` once at the end of the phase. Document the choice in the Phase 4 commit messages.

## Out of scope

Items deliberately not in this plan that someone might assume are:

- **Item #6 (`runDir` → `outDir` rename).** Deferred per Skeptic's review — not pure synonyms; `orchestrator.ts:187` deliberately remaps `runDir: outDir` across a module boundary. 200-site grind for low leverage.
- **`cli/args.ts` per-command allowed-flag sets** (`RUN_ALLOWED`, `BATCH_ALLOWED`, `VALIDATE_ALLOWED`, `FANOUT_ALLOWED`, `SERVE_ALLOWED`, `CONFIG_ALLOWED`, `ASK_ALLOWED` + `rejectUnknownFlags`). The spec called these out as "same pattern, smaller scale" but Phase 4 covers only `config.ts`. If the `resolveSetting` work goes smoothly and there's time, the args-parser tidy is a natural follow-on — but track it as a separate ticket.
- **No barrel `index.ts` exports.** The repo has none and we're not introducing them.
- **No new tests beyond the ones in Phase 4 (`resolveSetting` unit test + `source-attribution` regression test).** Existing test coverage is the safety net; this sweep does not chase coverage as a goal.
- **No CI / tooling changes.** `tsconfig.json`, `package.json`, lint config are untouched.
- **No `chrome-ws-lib` dependency changes.** Out of scope for this sweep.

---

## Action-observer survey (Phase 1 deferral)

Surveyed by Mason@5fb65729 as Task 1.3 — investigate-only, decision pending Susan review.

### What the two channels are

`EvidenceLogger` exposes two parallel observer channels (see `src/evidence/logger.ts:150-176`):

- **`addObserver(fn: ActionObserver)`** — legacy channel. Fires `(action, params)` only on `logToolCall` (line 230) and `logEvent` (line 287). Receives a string + a params bag; loses the structured wrapper (eventId, parentEventId, ts, type) that everything else gets.
- **`addEventObserver(fn: EventObserver)`** — newer channel (comment at line 163: "Second, independent observer channel — spec §6.3"). Fires on every `writeEvent` (line 190), so every row that lands in `run.jsonl` is delivered, with the full structured shape.

Both fire side-by-side. Comment at line 166 calls the older channel "legacy" but does not commit to a removal.

### Callers of `addObserver` (legacy)

| Site | Shape consumed | Purpose |
|------|----------------|---------|
| `src/api/routes/run.ts:80` | `(action, params)` — formats `[${action}] ${JSON.stringify(params)}` | Sends a `"progress"` WS message + records progress in `ActiveRunRegistry`. Strictly action-name + raw params, no event metadata. |
| `test/evidence/logger.test.ts:52,72,88,99,102,113,355` | various | Unit tests of the channel itself (will follow whatever fate the channel meets). |

**Only one production caller.** `src/api/routes/run.ts:80` is the sole non-test consumer. It exists alongside an `addEventObserver` caller four lines below (line 92) that broadcasts the full event over WS.

### Callers of `addEventObserver`

| Site | Shape consumed | Purpose |
|------|----------------|---------|
| `src/api/routes/run.ts:92` | full event | WS `"event"` broadcast — the real-time UI feed. |
| `src/cli/run.ts:70` | full event | Single-pass CLI: derives `cardId`, `status`, `turns` from the event, drives the progress table + JSONL sink. |
| `src/cli/batch.ts:73,209` | full event | Batch CLI: same as above, two sites for the two batch modes. |
| `src/cli/stream/attach.ts:24` | full event | Drives `StreamRenderer` (pretty or jsonl) — the CLI streaming transcript. |
| `test/cli/batch.test.ts` (6 sites) + `test/evidence/logger.test.ts` (5 sites) | full event | Test doubles + channel unit tests. |

Five distinct production consumers. All read the full structured event (looking at `event.type`, `event.status`, `event.usage.turns`, etc.). The event channel is the live one.

### What the legacy channel costs

- One conditional notify on each `logToolCall` (line 230) and `logEvent` (line 287). Cheap.
- A second observer registration in `api/routes/run.ts` (lines 78-89), three lines of params-to-string formatting.
- A "this looks duplicative" mental tax on every reader of the logger code and the run-route hook setup.

### What the legacy channel uniquely provides

Looking at `api/routes/run.ts:80-89` — the `progress` WS message format (`[${action}] ${JSON.stringify(params)}`) is a human-readable progress string consumed by the UI as `"progress"` messages and by `ActiveRunRegistry.recordProgress` as a string. The event channel right below (line 92) sends full structured events as `"event"` messages.

These are **two distinct WS message channels** (`"progress"` vs `"event"`). Whether anything still consumes `"progress"` on the UI side is the load-bearing question. If `"progress"` is unconsumed, the legacy observer channel can retire cleanly. If `"progress"` is consumed, then the work is "compute the same string from the event-channel event" rather than retire-and-delete.

`ActiveRunRegistry.recordProgress` is also a question — does anything read it after the run finishes? If yes, it can be fed from a synthesized string off the event channel.

### Recommendation

**Rename, do not retire.** The legacy `addObserver` channel has only one production consumer and that consumer immediately reformats `(action, params)` into a progress string. The same string is derivable from the structured event the new channel delivers — but the synthesis would need to live somewhere (likely in `api/routes/run.ts` itself), and it would lose the property that "anything fired through `logToolCall`/`logEvent` makes a progress message" by default.

The cheap intermediate move:

1. Rename the channel from `addObserver` / `notifyObservers` to `addProgressObserver` / `notifyProgressObservers` so its narrower purpose (driving the progress WS feed) is in the name. Drop the "legacy" comment.
2. Leave `api/routes/run.ts:80` as-is, just calling the renamed method.
3. File the "verify UI still consumes `progress` WS messages, otherwise retire" as a follow-on ticket — needs a brief audit of the UI side that's outside this sweep's spec scope.

The full retire-and-fold-into-event-channel move is doable, but it's a small architectural decision in its own right (where does the synthesis live, what's the eventId discipline) and not type-only. Susan should decide whether to take that path.

### Open question for Susan

Does the web UI (under `ui/`) consume the `"progress"` WS message type, or only `"event"`? `rg -n '"progress"' ui/src/` would answer it in seconds — but the audit before dispatch did not surface this and I want to flag it explicitly rather than fold a UI audit into a "small tidies" task.
