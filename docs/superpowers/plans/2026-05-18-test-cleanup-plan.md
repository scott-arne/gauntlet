# PRI-1630 — Test suite cleanup — implementation plan

> **For agentic workers:** Execute phase-by-phase. Each phase ends in a green `bun run check` and a commit. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Address all 11 items in `docs/notes/test-audit-2026-05.md` (the spec for PRI-1630) without breaking any existing behavior or test, and without growing the suite faster than it shrinks.

**Architecture:** Nine phases (0–8). Order: cheap-and-safe first, the cross-coupled bits last, and net-new tests near the end where the helpers they'd use already exist. Every phase leaves the working tree green; the work can be paused after any phase. No PRs — single feature branch, merged into `main` with `--no-ff` at the end.

**Tech Stack:** TypeScript (strict, ES2022, bundler resolution), Bun 1.3+, Node-compatible. Tests via `bun test`. `bun run check` runs typecheck + UI typecheck + UI build + tests.

**Worktree:** `/Users/mw/Code/prime/gauntlet-tests` on branch `matt/pri-1630-test-suite-cleanup-duplication-helpers-real-port-binding` (the gitBranchName Linear assigned to PRI-1630). The path is arbitrary — chosen because it sits next to the existing `gauntlet-pri-1628` worktree. Memory: `feedback_multi_agent_checkout_collision.md` — verify `git branch --show-current` before each commit.

**Cross-ticket coordination:**

- **PRI-1629** (typecheck baseline fix on main) — Phase 0 requires this to be merged. Until then, `bun run check` is not a usable baseline.
- **PRI-1628** (source-code cleanup sweep) — Phase 4 of this plan rebases on PRI-1628's `pri-1628-phase-2` tag (the config-type collapse). The four `makeConfig()` copies will be re-typed to `ResolvedRunConfig` at that point.

**Commit attribution.** Every commit uses `Co-Authored-By: <YourBobName>@<first8hex> (Opus 4.7)` — substitute your real SCUT handle. Do not commit the literal placeholder.

---

## Audit corrections (read before Phase 1)

Three claims in the audit don't match the source files as they stand today. The plan executes the corrected version of each item.

1. **Item #1 (CLI-adapter API mismatch).** The audit claimed the two test files use *incompatible* APIs (`executeTool()` vs `type()`). In fact, both files call `executeTool()`. The second file (`test/adapters/cli/adapter.test.ts`) *additionally* calls `adapter.type()` directly in two shell-input lifecycle tests — `adapter.type()` is a real public method on `CLIAdapter` (defined at `src/adapters/cli/adapter.ts:124`) and is also called internally by `executeTool("type", ...)`. The two test files are **complementary angles** (an integration suite using a real `EvidenceLogger` + Docker shell, plus an API-contract suite using a mock logger + cheap shells like `echo`/`cat`). The investigation in Phase 2 still happens — to confirm the angles are intentional and propose tightening — but the executor must not delete one side based on the audit's framing.

2. **Item #2 (pick-free-port is mock-and-mirror).** Misframed. `test/helpers/pick-free-port.test.ts` imports the real `pickFreePort` function and calls it; the source function (`src/util/pick-free-port.ts`, 26 LOC) already does real port binding via `net.createServer().listen(0, ...)`. The actual gap is that the test never re-binds the returned port to prove it's still bindable. The "fix" is a small addition (one assertion that the returned port can be bound), not a rewrite.

3. **Item #7 (5 low-value tests to delete).** Audit listed `test/cli/stream/wrap.test.ts:36` with the example `formatWidthPercent(100, 0.5) === 50`. No such function or test exists in the file. All five `wrap.test.ts` tests look meaningful. Drop `wrap.test.ts` from the deletion list. **Three deletable tautologies remain** (`paths.test.ts:37-39`, `initial-message.test.ts:5-10`, `streaming/screencast.test.ts:14-17`).

Also worth knowing: `streaming/screencast.test.ts` already has two non-tautology tests (lines 27-52) covering the saveDir-eager-create behavior. Only the line 14-17 smoke test is deletable.

These corrections trim the deletion-count claim from 4 to 3 but do not change the phase structure.

---

## Phase 0 — Pre-flight

**Goal:** Confirm PRI-1629 has merged, baseline is green on a clean worktree.

- [ ] **Step 0.1: Confirm PRI-1629 has merged to main.**

```bash
cd /Users/mw/Code/prime/gauntlet
git fetch origin main
git log origin/main --oneline -20 | rg -i 'PRI-1629|typecheck'
```

If no PRI-1629 commit appears on main, **stop**. Another Bob is fixing the broken typecheck baseline concurrently; without their fix, `bun run check` will fail before any test change can be evaluated. Ping Susan via SCUT and wait.

- [ ] **Step 0.2: Create the worktree.**

```bash
cd /Users/mw/Code/prime/gauntlet
git worktree add ../gauntlet-tests -b matt/pri-1630-test-suite-cleanup-duplication-helpers-real-port-binding main
cd ../gauntlet-tests
```

- [ ] **Step 0.3: Install and verify baseline.**

```bash
bun install
bun run check
```

Expected: typecheck passes, UI typecheck passes, UI build succeeds, all tests pass.

If the baseline is not green, **stop**. Investigate (likely a PRI-1629 regression slipped through) before layering changes on top.

- [ ] **Step 0.4: Record baseline test count.**

```bash
bun test 2>&1 | tail -5
```

Note the number of tests passing. Each phase should match or exceed this number, *except* Phase 1 (which deletes 3 tautologies — count drops by exactly 3) and Phase 2 if a CLI-adapter test consolidation lands (count may drop by a known amount documented in the commit). Any other reduction is suspicious.

- [ ] **Step 0.5: No commit yet.** Phase 0 produces no diff.

---

## Phase 1 — Small tidies

**Goal:** Items #7 (deletions), #9 (credential-fixture helper), #11 (move pick-free-port). All low-risk, mechanical, pay off immediately. Net change is small and the diff reads cleanly.

### Task 1.1 — Delete 2 tautology tests (item #7, corrected)

**Files:**
- Modify: `test/paths.test.ts` — delete the `GAUNTLET_DIRNAME is the literal .gauntlet convention` test (lines 37-39)
- Modify: `test/agent/initial-message.test.ts` — delete the `baseline message with no target` test (lines 5-10)

**Note:** the third tautology (`test/streaming/screencast.test.ts:14-17`'s `can be constructed`) is **NOT deleted here**. Per Garibaldi's review: deleting it in Phase 1 opens a coverage gap if Phase 6 is later deferred. Phase 6 deletes that test atomically with the commit that adds real lifecycle assertions.

- [ ] **Step 1.1.1: Delete the two tests by hand.** Keep surrounding tests intact; delete only the test body and the trailing blank line.

- [ ] **Step 1.1.2: Run check.**

```bash
bun run check
```

Expected: PASS, test count = baseline − 2.

- [ ] **Step 1.1.3: Commit Task 1.1.**

```bash
git commit -am "test: delete 2 tautology tests (PRI-1630 phase 1)

- paths.test.ts: GAUNTLET_DIRNAME literal check (tautology)
- initial-message.test.ts: baseline-message check (compares to a string
  copy-pasted from the source)

The third tautology (screencast.test.ts 'can be constructed') is
deleted in phase 6 atomically with the real lifecycle assertions
that replace it."
```

### Task 1.2 — Move `pick-free-port.test.ts` from `helpers/` to `util/` (item #11)

**Files:**
- Move: `test/helpers/pick-free-port.test.ts` → `test/util/pick-free-port.test.ts`

`test/helpers/` should hold shared test utilities, not test files. The other `src/util/*` tests already live in `test/util/`.

- [ ] **Step 1.2.1: Move the file with `git mv` (preserves history).**

```bash
git mv test/helpers/pick-free-port.test.ts test/util/pick-free-port.test.ts
```

- [ ] **Step 1.2.2: Verify import paths still resolve.**

The file imports `../../src/util/pick-free-port`. After moving from `test/helpers/` to `test/util/`, that path still resolves to `src/util/pick-free-port.ts` — same depth.

- [ ] **Step 1.2.3: Run check.**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 1.2.4: Commit Task 1.2.**

```bash
git commit -am "test: move pick-free-port.test.ts to test/util/ (PRI-1630 phase 1)

test/helpers/ is reserved for shared test utilities, not test files."
```

### Task 1.3 — Extract `credential-fixture.ts` helper (item #9)

**Files:**
- Create: `test/helpers/credential-fixture.ts`
- Modify: `test/adapters/cli/adapter.test.ts` — three repeated setups around lines 107-162

Audit identified the same `mkdtempSync` + `writeFileSync` + `chmodSync` + `try/finally rmSync` pattern repeated three times in one file (across the three credential-resolver tests).

- [ ] **Step 1.3.1: Read the three sites to confirm the pattern is uniform.**

```bash
sed -n '100,170p' test/adapters/cli/adapter.test.ts
```

Confirm the three blocks share: (a) creating a context temp dir, (b) optionally creating a resolver temp dir + a shell-script resolver chmod 0755, (c) cleaning up both in a `finally`. Differences are surface (resolver script body) and presence/absence of the resolver dir.

- [ ] **Step 1.3.2: Design the helper.**

A small `withCredentialFixture(opts, fn)` that:
- accepts `{ resolverScript?: string; contextFiles?: Record<string, string> }`
- creates one or two temp dirs (context always; resolver only if `resolverScript` provided)
- writes context files; writes + chmods the resolver script
- yields `{ contextDir, resolverPath?: string }` to `fn`
- `try/finally`-cleans up both dirs

```ts
// test/helpers/credential-fixture.ts
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface CredentialFixture {
  contextDir: string;
  resolverPath?: string;
}

export interface CredentialFixtureOpts {
  contextFiles?: Record<string, string>;
  resolverScript?: string;
  prefix?: string;
}

export async function withCredentialFixture<T>(
  opts: CredentialFixtureOpts,
  fn: (fx: CredentialFixture) => Promise<T> | T,
): Promise<T> {
  const prefix = opts.prefix ?? "gauntlet-cred-";
  const contextDir = mkdtempSync(join(tmpdir(), `${prefix}ctx-`));
  let resolverDir: string | undefined;
  let resolverPath: string | undefined;
  try {
    for (const [name, body] of Object.entries(opts.contextFiles ?? {})) {
      writeFileSync(join(contextDir, name), body);
    }
    if (opts.resolverScript) {
      resolverDir = mkdtempSync(join(tmpdir(), `${prefix}res-`));
      resolverPath = join(resolverDir, "resolver.sh");
      writeFileSync(resolverPath, opts.resolverScript);
      chmodSync(resolverPath, 0o755);
    }
    return await fn({ contextDir, resolverPath });
  } finally {
    rmSync(contextDir, { recursive: true, force: true });
    if (resolverDir) rmSync(resolverDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 1.3.3: Refactor the three sites in `test/adapters/cli/adapter.test.ts`.**

Each becomes `await withCredentialFixture({ contextFiles: {...}, resolverScript: "..." }, async ({ contextDir, resolverPath }) => { ... })`.

- [ ] **Step 1.3.4: Run check.**

```bash
bun run check
```

Expected: PASS, no test count change.

- [ ] **Step 1.3.5: Commit Task 1.3.**

```bash
git commit -am "test/helpers: extract withCredentialFixture; refactor 3 sites (PRI-1630 phase 1)

The mkdtemp + writeFile + chmod + finally-rmSync pattern was repeated
three times in test/adapters/cli/adapter.test.ts. One helper, three call
sites collapsed."
```

### Phase 1 wrap-up

- [ ] **Step 1.4: Tag and rebase.**

```bash
git tag pri-1630-phase-1
git fetch origin main && git rebase origin/main
```

---

## Phase 2 — Investigate CLI-adapter overlap (item #1, HARD GATE)

**Goal:** Read both test files end-to-end, read the `CLIAdapter` source end-to-end, write a survey, and surface findings to Susan **before any deletion or merge**. This phase produces a doc-only commit and stops.

The audit's framing of "incompatible APIs" was wrong (see "Audit corrections" above). The real question is whether the two files are intentionally complementary (integration angle vs. API-contract angle) or whether one is dead.

### Task 2.1 — Survey

**Files (read-only this phase):**
- `src/adapters/cli/adapter.ts` (239 LOC)
- `test/adapters/cli-adapter.test.ts` (146 LOC)
- `test/adapters/cli/adapter.test.ts` (171 LOC)

- [ ] **Step 2.1.1: Read `src/adapters/cli/adapter.ts` end-to-end.**

Inventory the public surface: which methods are part of the `Adapter` interface (called via `executeTool` from the agent), which are convenience methods exposed for direct test use, and which are private. Confirm that `type()` and `read_output()` are both publicly exposed *and* dispatched via `executeTool()` (the source confirms this at lines 199-225).

- [ ] **Step 2.1.2: Read both test files end-to-end.**

For each file, classify every test by:
- the entry point used (`adapter.start`, `adapter.executeTool`, `adapter.type`, `adapter.close`)
- the dependency style (real `EvidenceLogger` vs. mock logger; real subprocess via `docker` vs. `echo`/`cat`)
- the behavior being pinned (lifecycle, tool definition contract, viewport, credential context flag, event flow, etc.)

- [ ] **Step 2.1.3: Identify overlap and proper coverage.**

For each behavior covered in both files, decide: which test's framing is stronger? Where do they cover *different* behaviors? Is any test currently dead-coding a path that no longer exists?

- [ ] **Step 2.1.4: Write the survey as a doc-only commit.**

Append a section `## CLI-adapter test overlap survey (Phase 2, PRI-1630)` to this plan file. Cover:
- Public surface of `CLIAdapter`, with one-line role for each method.
- For each test file: a table of test → entry-point → dependency-style → behavior-pinned.
- Identified overlap: which behaviors are tested twice; which file's version is stronger.
- Recommended action: one of
  - **(a)** Keep both; tighten by removing N overlapping tests from one file (specify which file and which tests).
  - **(b)** Merge into a single file (specify target path and how to preserve both angles).
  - **(c)** Surface a finding the executor cannot decide — e.g., a path that looks dead and needs Susan's call on whether to delete.

- [ ] **Step 2.1.5: Commit the survey.**

```bash
git add docs/superpowers/plans/2026-05-18-test-cleanup-plan.md
git commit -m "docs: cli-adapter test overlap survey (PRI-1630 phase 2 gate)"
```

### Phase 2 wrap-up — HARD GATE

- [ ] **Step 2.2: Tag the gate.**

```bash
git tag pri-1630-phase-2-gate
```

- [ ] **Step 2.3: STOP. Ping Susan via SCUT.**

The executor does not delete or merge CLI-adapter tests autonomously. The survey is reviewed; Susan picks the action; only then does the executor proceed in a follow-up commit (or defers item #1 to a future ticket).

After Susan's review, if approved:

```bash
# Apply the chosen action (deletion or merge) as a separate commit:
git commit -am "test: resolve cli-adapter overlap per phase 2 survey (PRI-1630)"
git tag pri-1630-phase-2
git fetch origin main && git rebase origin/main
```

If deferred:

```bash
git tag pri-1630-phase-2
```

Skip to Phase 3 either way. Tag the phase to keep the boundary stable.

---

## Phase 3 — Fix `pick-free-port.test.ts` to bind a real port (item #2)

**Goal:** The function under test IS the OS-port-binding logic. Mocking the binding defeats the purpose. The current test calls the real function but never re-binds the returned port to prove it's still bindable. Add that assertion.

**Why this is the only file in the suite that should do a real network op:** for *any other* test, "is this port bindable?" is a precondition you pass into the test, not something the test verifies. For *this* test, "is the returned port bindable?" IS the contract under test. The function's job — picking a port that the caller can actually bind — has no useful test that doesn't include the bind step.

**Files:**
- Modify: `test/util/pick-free-port.test.ts` (moved here in Phase 1)

### Task 3.1 — Add the real-bind assertion

- [ ] **Step 3.1.1: Write the new test.**

```ts
import { describe, test, expect } from "bun:test";
import { createServer } from "net";
import { pickFreePort } from "../../src/util/pick-free-port";

describe("pickFreePort", () => {
  test("returns a number in the valid TCP port range", async () => {
    const port = await pickFreePort();
    expect(typeof port).toBe("number");
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });

  test("two calls return different ports", async () => {
    const a = await pickFreePort();
    const b = await pickFreePort();
    expect(a).not.toBe(b);
  });

  test("returned port is actually bindable", async () => {
    // The function under test IS the OS-port-binding logic. Verifying
    // the returned port can be bound is the actual contract — the prior
    // tests only check the *shape* of what's returned.
    //
    // TOCTOU note: pickFreePort releases the port before returning, so a
    // racing process could grab it. The source code documents this and
    // expects callers to retry. The test accepts this tiny window —
    // EADDRINUSE here is rare in practice and would be visible as a
    // flake, not a silent regression.
    const port = await pickFreePort();
    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(port, "127.0.0.1", () => {
        srv.close(() => resolve());
      });
    });
  });
});
```

- [ ] **Step 3.1.2: Run check.**

```bash
bun run check
```

Expected: PASS, test count = baseline − 3 (Phase 1) + 1 (new bindable test).

- [ ] **Step 3.1.3: Commit Phase 3.**

```bash
git commit -am "test/util: assert pickFreePort returns a bindable port (PRI-1630 phase 3)

The function under test IS the OS-port-binding logic. Prior tests only
checked the shape of what's returned, never that the port is actually
usable. One bind-and-release assertion closes that gap."
```

### Phase 3 wrap-up

- [ ] **Step 3.2: Tag and rebase.**

```bash
git tag pri-1630-phase-3
git fetch origin main && git rebase origin/main
```

---

## Phase 4 — Extract `makeConfig` and `api-test-app` helpers (items #3, #4)

**Goal:** Two helpers that pay back across many test files. Item #3 is coupled to PRI-1628; item #4 stands alone.

### Task 4.1 — Wait for PRI-1628 phase 2 (config-type collapse)

`makeConfig()` returns an `AppConfig`, not `EffectiveRunConfig`/`RunCoreConfig`/`ResolvedRunConfig` — so strictly speaking the audit's coupling claim is wrong at the type level: extracting `makeConfig` does not depend on PRI-1628's type collapse. However:

- Three of the four `makeConfig` callers (`test/cli/run.test.ts`, `test/cli/batch.test.ts`, `test/cli/run-one.test.ts`) feed the returned `AppConfig` into call sites that eventually construct `EffectiveRunConfig`/`RunCoreConfig` via `mergeRunConfig`. PRI-1628 changes those downstream types but not `AppConfig` itself.
- Doing the extraction *after* PRI-1628 phase 2 avoids a near-certain rebase conflict if PRI-1628's executor touches any of the four files.

**Decision:** Rebase on `pri-1628-phase-2` if it exists; otherwise proceed against `origin/main`. This is a safety choice (avoid rebase conflicts), not a correctness one.

- [ ] **Step 4.1.1: Check PRI-1628 phase 2 status.**

```bash
git fetch origin main
git tag -l 'pri-1628-phase-*'
git log origin/main --oneline | rg 'PRI-1628.*phase 2' || echo "phase 2 not on main yet"
```

If `pri-1628-phase-2` is not yet on `origin/main`, **stop and ping Susan via SCUT**. Susan decides: wait, or proceed and accept the rebase risk.

If `pri-1628-phase-2` is on main, rebase:

```bash
git rebase origin/main
```

### Task 4.2 — Extract `makeConfig()` (item #3)

**Files:**
- Create: `test/helpers/make-config.ts`
- Modify: `test/api/fanout.test.ts`, `test/cli/run.test.ts`, `test/cli/batch.test.ts`, `test/cli/run-one.test.ts`

- [ ] **Step 4.2.1: Survey the four copies.**

```bash
grep -n "function makeConfig" test/api/fanout.test.ts test/cli/run.test.ts test/cli/batch.test.ts test/cli/run-one.test.ts
```

For each, read the full function. Note any per-file overrides (e.g. one might set `defaultBudgetMs: 60000` while others use `300000`).

**Known wrinkle** (flagged by Garibaldi): `test/cli/batch.test.ts:9`'s `makeConfig` takes **no `projectRoot` parameter** — it hard-codes a value. The other three take `projectRoot: string`. The helper signature below (`makeConfig(projectRoot, overrides)`) is the right shape for the three regular callers; for `batch.test.ts`, pass a stub `projectRoot` from the test (use `mkdtempSync` or a fixture path) rather than changing the helper signature to allow `projectRoot` to default. The "stub a path" change is one line per call site; preserving the helper's required-parameter discipline is worth more.

- [ ] **Step 4.2.2: Design the helper to accept overrides.**

```ts
// test/helpers/make-config.ts
import type { AppConfig } from "../../src/config";

export function makeConfig(
  projectRoot: string,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const base: AppConfig = {
    projectRoot,
    port: 4400,
    defaultChrome: { host: "127.0.0.1", port: 9222 },
    defaultBudgetMs: 300000,
    // ... full default AppConfig shape, current as of trunk
  };
  return { ...base, ...overrides };
}
```

**Important:** the helper sources `AppConfig`'s shape from `src/config.ts`. As `AppConfig` grows, this one helper is updated once. Per-file copies have lagged behind.

- [ ] **Step 4.2.3: Migrate the four call sites one at a time, committing each.**

For each file:
1. Delete the local `makeConfig` declaration.
2. Add `import { makeConfig } from "../helpers/make-config";` (adjust path depth).
3. If the local version had non-default values, pass them as the `overrides` argument.
4. `bun run check`.
5. Commit.

```bash
git commit -am "test: migrate test/api/fanout.test.ts to shared makeConfig (PRI-1630 phase 4)"
```

Four commits total — one per migrated file. Per-commit migration makes any regression bisectable to one site.

- [ ] **Step 4.2.4: Verify no remaining copies.**

```bash
grep -l "function makeConfig" test/
```

Expected: zero matches.

### Task 4.3 — Extract `api-test-app.ts` helper (item #4)

**Files:**
- Create: `test/helpers/api-test-app.ts`
- Modify: ~9 files in `test/api/` that use the `new Hono(); app.route(...); app.request(...)` pattern

- [ ] **Step 4.3.1: Survey the 9 sites.**

```bash
grep -l "new Hono()" test/api/
```

For each match, read the construction block to confirm the pattern is uniform (one app, one route mount, one `app.request(...)`).

- [ ] **Step 4.3.2: Design the helper.**

```ts
// test/helpers/api-test-app.ts
import { Hono } from "hono";

export interface RouteFactory {
  // Same shape as the existing route factories in src/api/routes/*.
}

export interface MountResult<TBody = unknown> {
  response: Response;
  body: TBody;
}

export async function mountRouteAndRequest<TBody = unknown>(
  routeMount: { path: string; routes: Hono },
  request: { method?: string; path: string; init?: RequestInit },
): Promise<MountResult<TBody>> {
  const app = new Hono();
  app.route(routeMount.path, routeMount.routes);
  const url = request.path;
  const init: RequestInit = { method: request.method ?? "GET", ...(request.init ?? {}) };
  const response = await app.request(url, init);
  const body = (await response.json()) as TBody;
  return { response, body };
}
```

If some call sites don't expect a JSON body (e.g. a 204), expose a sibling `mountRouteAndRequestRaw` that returns only the `Response`. Decide on the exact shape **after** the survey, not before. The above is illustrative.

- [ ] **Step 4.3.3: Migrate one file as a pilot.**

Pick the smallest of the nine (`test/api/caps.test.ts` is a good candidate). Migrate it, run check, commit. The pilot validates the helper shape before touching the other eight.

```bash
git commit -am "test/helpers: extract mountRouteAndRequest; pilot migrate caps.test.ts (PRI-1630 phase 4)"
```

- [ ] **Step 4.3.4: Migrate the remaining 8 files, committing each.**

Same loop as Task 4.2.3. If any site has a usage the helper doesn't cleanly support (e.g. multi-request flows), leave it un-migrated and document why in a comment at the site. Don't bend the helper for one outlier.

- [ ] **Step 4.3.5: Final check.**

```bash
bun run check
```

Expected: PASS, no test count change.

### Phase 4 wrap-up

- [ ] **Step 4.4: Tag and rebase.**

```bash
git tag pri-1630-phase-4
git fetch origin main && git rebase origin/main
```

---

## Phase 5 — Rename `test/e2e/` to `test/integration/` (item #8, HARD GATE before action)

**Goal:** The 12 files in `test/e2e/` are in-process integration tests (import adapters, run scripted multi-turn loops). They're not black-box e2e. Rename. The one true e2e test (`test/cli/binary-smoke.test.ts`, which `spawnSync`s the compiled binary) stays where it is — or is optionally moved into a new `test/e2e/`.

### Task 5.1 — Surface the scope decision

The audit says "rename `test/e2e/` to `test/integration/` (or whatever the right cut is — propose, surface, then act)." Two options:

- **(a) Simple rename.** `test/e2e/` → `test/integration/`. `test/cli/binary-smoke.test.ts` stays in `test/cli/`. The repo has no `test/e2e/` directory after this change. Future real e2e tests would live alongside `binary-smoke.test.ts` in `test/cli/`, or we'd reintroduce `test/e2e/` later when there's enough to warrant it.

- **(b) Rename + relocate.** `test/e2e/` → `test/integration/`, AND move `test/cli/binary-smoke.test.ts` → `test/e2e/binary-smoke.test.ts`. The `test/e2e/` directory exists post-rename, with one file in it. This is "the right" taxonomy but creates a near-empty directory.

- [ ] **Step 5.1.1: Read both `test/e2e/web-todomvc.test.ts` and `test/cli/binary-smoke.test.ts` end-to-end.**

Confirm: the `e2e/` files use in-process adapters/agents; `binary-smoke.test.ts` spawns the compiled binary. The classification holds.

- [ ] **Step 5.1.2: Write the decision as a doc-only commit.**

Append `## Test-tier rename decision (Phase 5, PRI-1630)` to this plan file with:
- A one-paragraph statement of the current state.
- Both options spelled out.
- A recommendation with a one-sentence rationale.

- [ ] **Step 5.1.3: Commit the survey, tag the gate, ping Susan.**

```bash
git add docs/superpowers/plans/2026-05-18-test-cleanup-plan.md
git commit -m "docs: test-tier rename decision (PRI-1630 phase 5 gate)"
git tag pri-1630-phase-5-gate
```

Stop and ping Susan via SCUT.

### Task 5.2 — Execute the chosen rename

After Susan picks an option:

- [ ] **Step 5.2.1: `git mv` the directory.**

For option (a):

```bash
git mv test/e2e test/integration
```

For option (b):

```bash
git mv test/e2e test/integration
mkdir test/e2e
git mv test/cli/binary-smoke.test.ts test/e2e/binary-smoke.test.ts
```

- [ ] **Step 5.2.2: Update relative imports inside the moved files.**

Each file imports `../../src/...`, `../helpers`, etc. The depth is unchanged (both `test/e2e/` and `test/integration/` are one level under `test/`), so imports continue to resolve. **Verify** with:

```bash
bun run typecheck
```

If TS complains about resolved paths, fix them. There shouldn't be any.

- [ ] **Step 5.2.3: Grep for stale references in docs and scripts.**

```bash
rg 'test/e2e' --type-not ts
```

Update any README, CONTRIBUTING, or script that references the old path.

- [ ] **Step 5.2.4: Run check.**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 5.2.5: Commit Phase 5.** Pick the commit message that matches the option Susan approved in Task 5.1:

**Option A — rename only, `binary-smoke.test.ts` stays where it is:**

```bash
git commit -am "test: rename test/e2e/ to test/integration/ (PRI-1630 phase 5)

The 12 files in the old test/e2e/ are in-process integration tests — they
import adapters directly and run scripted multi-turn loops against a
local fixture. binary-smoke.test.ts stays in test/cli/ — it's the
closest thing to a real e2e (spawns the gauntlet binary), but tier
boundaries weren't the only thing it bought us, so deferring."
```

**Option B — rename AND move binary-smoke to a fresh test/e2e/:**

```bash
git commit -am "test: rename test/e2e/ to test/integration/, move binary-smoke to test/e2e/ (PRI-1630 phase 5)

The 12 files in the old test/e2e/ are in-process integration tests — they
import adapters directly and run scripted multi-turn loops against a
local fixture. The real e2e (binary-smoke.test.ts — spawns the gauntlet
binary) now lives in test/e2e/ as the only file. The two tiers are now
honest about what they cover."
```

### Phase 5 wrap-up

- [ ] **Step 5.3: Tag and rebase.**

```bash
git tag pri-1630-phase-5
git fetch origin main && git rebase origin/main
```

---

## Phase 6 — Net-new tests: screencast lifecycle + serve.ts request errors (items #5, #6)

**Goal:** Close two genuine coverage gaps with proportional tests. The trap to avoid: mocking enough that the new test becomes another mock-and-mirror. The discipline: pin behavior that *could plausibly regress*, not implementation details.

### Task 6.1 — Screencast lifecycle (item #5)

**Files:**
- Modify: `test/streaming/screencast.test.ts`
- Source under test: `src/streaming/screencast.ts` (121 LOC)
- New (Step 6.1.1 only): `docs/superpowers/specs/2026-05-18-screencast-lifecycle-surface.md`

**Design discipline.** Per Garibaldi's review, this task is *not* a pure "write tests" task — it requires a real design step because the stub-session contract has to mirror what `screencast.ts` actually consumes. Skipping the survey produces a stub whose surface is guessed-at, which produces tests that pass for the wrong reasons. Phase 6.1.1 is therefore a survey-as-commit step (same pattern as Phase 2 and Phase 5).

**What to pin.** The lifecycle gap is:
- `start()` — what happens when called on a streamer; what side-effects on the session
- `stop()` — idempotent? safe to call without start? leaves any handles dangling?
- `onFrame` — does the callback fire when a frame event arrives from the session? does it fire with the saveDir frame path when saveDir is set?
- Frame-save logic — when a frame arrives with saveDir set, does a file appear at the expected path?

- [ ] **Step 6.1.1: Read `src/streaming/screencast.ts` end-to-end and produce a surface doc.**

Write `docs/superpowers/specs/2026-05-18-screencast-lifecycle-surface.md` containing:

- **Session surface used by `screencast.ts`** — for each method called on the constructor-injected session, list: method name, signature (params + return), call site in `screencast.ts` (file:line), and whether the call is synchronous or `await`ed.
- **Frame event shape** — the exact TypeScript type / property names the streamer's frame handler destructures. If `screencast.ts` uses any duck-typed access (`evt.data`, `evt.metadata.timestamp`), record it precisely. The stub frame the test emits must match.
- **stop() idempotency** — what `screencast.ts` actually does on a second `stop()` call. Look at the source; answer "no-op", "throws", or "double-stops the session" (one of these is correct; the test should pin the actual one).
- **Frame-save synchrony** — is the file write synchronous from the frame handler (`writeFileSync`) or asynchronous (`writeFile` + await)? Determines whether the test polls or asserts directly.

Commit the surface doc as a doc-only commit:

```bash
git add docs/superpowers/specs/2026-05-18-screencast-lifecycle-surface.md
git commit -m "docs: screencast lifecycle surface for PRI-1630 phase 6 design"
```

This is a small commit (~50 lines). It's load-bearing for the rest of Phase 6 — every later step references "the surface".

- [ ] **Step 6.1.2: Design the stub session against the surface doc.**

```ts
// In test/streaming/screencast.test.ts (local to the file)
// Frame event shape MUST match the surface doc's "Frame event shape" section.
interface FrameEvent { /* exact fields from surface doc */ }

function makeStubSession() {
  let frameHandler: ((evt: FrameEvent) => void) | undefined;
  const calls: { startScreencast: number; stopScreencast: number } = {
    startScreencast: 0, stopScreencast: 0,
  };
  return {
    // ONLY the methods listed in the surface doc's "Session surface" section.
    // If you find yourself adding a method here that's not in the doc,
    // the doc is incomplete — go update the doc first, then re-commit it.
    startScreencast: async () => { calls.startScreencast += 1; },
    stopScreencast: async () => { calls.stopScreencast += 1; },
    onFrame: (h: (evt: FrameEvent) => void) => { frameHandler = h; },
    // Test affordance — push a frame as if from the wire:
    _emit(evt: FrameEvent) { frameHandler?.(evt); },
    _calls: calls,
  };
}
```

- [ ] **Step 6.1.3: Delete the existing `can be constructed` tautology AND write the real lifecycle tests in one atomic commit.**

This is the deferred deletion from Task 1.1. The deletion and the replacement land together so there is no point in time where the file has neither the smoke test nor the real lifecycle assertions.

```ts
// REMOVE: the `can be constructed` test at lines 14-17.
// KEEP: the existing saveDir-eager-create tests (they pin real behavior).
// ADD: three lifecycle tests + one frame-save test, per below.

test("start() invokes session.startScreencast", async () => {
  const session = makeStubSession();
  const streamer = new ScreencastStreamer(0, () => {}, session);
  await streamer.start();
  expect(session._calls.startScreencast).toBe(1);
});

test("stop() invokes session.stopScreencast (idempotency per surface doc)", async () => {
  const session = makeStubSession();
  const streamer = new ScreencastStreamer(0, () => {}, session);
  await streamer.start();
  await streamer.stop();
  await streamer.stop();
  // Expected count comes from the surface doc's "stop() idempotency" entry.
  // If the doc says "no-op", expect 1. If "double-stops the session", expect 2.
  expect(session._calls.stopScreencast).toBe(/* from surface doc */);
});

test("onFrame callback fires when session emits a frame", async () => {
  const session = makeStubSession();
  const seen: unknown[] = [];
  const streamer = new ScreencastStreamer(0, (frame) => { seen.push(frame); }, session);
  await streamer.start();
  session._emit({ /* sample frame matching surface doc's frame shape */ });
  expect(seen.length).toBe(1);
});
```

- [ ] **Step 6.1.4: Write one frame-save test.**

```ts
test("a frame received while saveDir is set writes a file to saveDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-screencast-"));
  try {
    const framesDir = join(root, "frames");
    const session = makeStubSession();
    const streamer = new ScreencastStreamer(0, () => {}, session, framesDir);
    await streamer.start();
    session._emit({ /* sample frame with known data per surface doc */ });

    // Whether to poll depends on the surface doc's "Frame-save synchrony" entry:
    // - synchronous: assert directly, no polling
    // - asynchronous: poll readdirSync(framesDir) with a 1s ceiling
    const files = readdirSync(framesDir);
    expect(files.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6.1.5: Run check.**

```bash
bun run check
```

Expected: PASS. Test count delta from this task: **+3** (start, stop, onFrame, plus the frame-save test = +4 added, −1 smoke deleted = net +3).

- [ ] **Step 6.1.6: Commit.**

```bash
git commit -am "test: screencast lifecycle assertions (PRI-1630 phase 6, item #5)

Replaces the 'can be constructed' smoke test with real lifecycle
assertions: start invokes startScreencast, stop is idempotent per the
surface doc, onFrame callback fires on emitted frames, frames write
to saveDir when set. Stub session surface mirrors the screencast
contract documented in docs/superpowers/specs/2026-05-18-screencast-lifecycle-surface.md."
```

- [ ] **Step 6.1.6: Commit Task 6.1.**

```bash
git commit -am "test/streaming: add screencast lifecycle tests (PRI-1630 phase 6)

Pins start/stop/onFrame and frame-save behavior using a minimal stub
session. Replaces the prior 'can be constructed' smoke test (deleted in
phase 1) with assertions that would fail on real regressions."
```

### Task 6.2 — `runtime/serve.ts` request errors (item #6)

**Files:**
- Create: `test/runtime/serve-errors.test.ts` (or add to an existing `test/runtime/serve.test.ts` if one exists — verify with `ls test/runtime/`)
- Source under test: `src/runtime/serve.ts` (133 LOC)

**What to pin.** Per the audit, server bring-up and shutdown are well tested; the gap is per-request error branches:
- malformed JSON in a POST body
- oversized payload (`maxRequestBodySize` exceeded)
- mid-flight closed connection (client disconnect during handler)

**Fixture strategy.** Use the real `serve()` on a real port (from `pickFreePort`). Use `fetch()` to drive requests. This is the right tier — `runtime/serve.ts` is the cross-runtime HTTP layer, and its error behavior is observable only end-to-end. Mocking the HTTP layer here would defeat the test.

- [ ] **Step 6.2.1: Verify the surface.**

```bash
ls test/runtime/ 2>&1 || echo "no test/runtime/ yet"
sed -n '1,80p' src/runtime/serve.ts
```

- [ ] **Step 6.2.2: Write the three tests.**

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { serve } from "../../src/runtime/serve";
import { pickFreePort } from "../../src/util/pick-free-port";

describe("runtime/serve error paths", () => {
  let port: number;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    port = await pickFreePort();
    const handle = serve({
      port,
      // …minimal handlers that echo JSON body or throw if requested.
    });
    stop = handle.stop;
  });

  afterEach(async () => {
    await stop();
  });

  test("malformed JSON request body yields a structured 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    // Verify the response shape the server is contracted to return.
  });

  test("oversized payload is rejected", async () => {
    // Construct a body just over the configured maxRequestBodySize.
    // …
  });

  test("mid-flight connection close does not crash the server", async () => {
    // Start a slow request, abort it client-side, assert the server is
    // still healthy via a subsequent quick request.
    const ac = new AbortController();
    const slowReq = fetch(`http://127.0.0.1:${port}/slow`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(slowReq).rejects.toThrow();
    const followup = await fetch(`http://127.0.0.1:${port}/health`);
    expect(followup.ok).toBe(true);
  });
});
```

The exact handler shapes depend on `serve.ts`'s actual entry points. Step 6.2.1 reveals which routes the test must mount.

- [ ] **Step 6.2.3: Run check.**

```bash
bun run check
```

Expected: PASS. Test count grows by 3.

If any test is flaky (the "mid-flight close" case is the most likely candidate), investigate the root cause — don't `.skip` it. If the source genuinely doesn't pin this contract (e.g., a client abort isn't recoverable on Bun), document that in the commit and either skip that one test with a referenced source-side ticket or drop the assertion to a milder one.

- [ ] **Step 6.2.4: Commit Task 6.2.**

```bash
git commit -am "test/runtime: add per-request error tests for serve.ts (PRI-1630 phase 6)

Three new tests: malformed JSON body, oversized payload, mid-flight
client abort. Driven against a real serve() on a real port — this is
the cross-runtime HTTP layer and its error behavior is observable
only end-to-end."
```

### Phase 6 wrap-up

- [ ] **Step 6.3: Tag and rebase.**

```bash
git tag pri-1630-phase-6
git fetch origin main && git rebase origin/main
```

---

## Phase 7 — Bounded api/ ratio audit (item #10) — HARD GATE between survey and action

**Goal:** The audit flagged a 4.21× api/ test ratio and suspected redundant edge-case sprawl. Open-ended "audit" can grow into "rewrite half the suite," and an honor-system "stop when you hit the bound" creates motivated reasoning to declare "we found just enough sprawl to be productive."

**Restructured per Garibaldi's review:** Phase 7 is **survey-only by default**. The survey produces a doc-only commit listing candidates. Consolidation requires Susan's explicit sign-off on the candidate list before any test file is modified. **"Found nothing" is a valid and expected outcome.** The 4.21× ratio is a *hypothesis* not a *finding* — route handlers are integration boundaries and a wide assertion surface is legitimately reasonable.

**Files in scope (per `wc -l` of test/api):**
- `test/api/run.test.ts` (401 LOC)
- `test/api/fanout.test.ts` (392 LOC)
- `test/api/results.test.ts` (285 LOC)

### Task 7.1 — Survey only

- [ ] **Step 7.1.1: Read each of the three files end-to-end.**

For each: list every test, group by the *shape* of the assertion ("returns 400 with `{error: ...}` on missing field X", "returns 422 on malformed shape", etc.).

- [ ] **Step 7.1.2: Write the survey as `docs/notes/api-test-survey-2026-05.md`.**

Cover:
- For each of the three files: total tests, count of tests grouped by shared assertion shape, candidates for parameterization (if any), candidates for outright deletion (if any).
- A bottom-line judgment: "consolidation candidates exist" or "no consolidation candidates — ratio is justified."
- **Do not modify any test file in this step.** No `.test.ts` edits.

- [ ] **Step 7.1.3: Commit the survey as doc-only and STOP.**

```bash
git add docs/notes/api-test-survey-2026-05.md
git commit -m "docs: api/ test-ratio survey for PRI-1630 phase 7 (review gate)"
```

**This is a hard gate.** Ping Susan via SCUT with the survey's bottom-line judgment. Three outcomes:

- Susan approves a specific candidate list → proceed to Task 7.2 with that exact list, no scope expansion.
- Susan defers consolidation to a future ticket → tag `pri-1630-phase-7` (no consolidation commits) and move to Phase 8.
- Survey concluded "no candidates" → tag `pri-1630-phase-7` directly and move to Phase 8.

### Task 7.2 — Consolidate (only with Susan's approval of a specific candidate list)

For each candidate Susan explicitly approved:

- [ ] **Step 7.2.N: Replace N tests with 1 parameterized test.**

`bun:test` supports `test.each` (or use a `for` loop with `test()` inside `describe`). The new test must cover *every* input the prior tests covered — drop nothing. The post-change test count must equal `pre − N + 1` per candidate.

- [ ] **Step 7.2.N+1: Run check; commit per candidate.**

```bash
git commit -am "test/api: consolidate <specific cases> in <file> (PRI-1630 phase 7)"
```

### Phase 7 wrap-up

- [ ] **Step 7.3: Tag and rebase.**

```bash
git tag pri-1630-phase-7
git fetch origin main && git rebase origin/main
```

Tag regardless of whether consolidation happened — the tag marks the phase boundary, not whether work landed.

---

## Phase 8 — Wrap-up

- [ ] **Step 8.1: Final `bun run check`.**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 8.2: Verify the negative-assertion matrix.**

```bash
echo "=== Phase 1 assertions ==="
rg -c 'GAUNTLET_DIRNAME is the literal' test/   # expect: 0
rg -c 'baseline message with no target' test/agent/  # expect: 0
rg -c '"can be constructed"' test/streaming/  # expect: 0
ls test/helpers/pick-free-port.test.ts 2>&1 || echo "moved (expected)"
ls test/util/pick-free-port.test.ts && echo "present (expected)"
rg -c 'mkdtempSync.*cred' test/adapters/cli/adapter.test.ts  # expect: 0 (now via helper)

echo "=== Phase 3 assertions ==="
rg -c 'returned port is actually bindable' test/util/pick-free-port.test.ts  # expect: 1

echo "=== Phase 4 assertions ==="
grep -l "function makeConfig" test/ | wc -l  # expect: 0
ls test/helpers/make-config.ts test/helpers/api-test-app.ts  # expect: both exist

echo "=== Phase 5 assertions ==="
ls test/e2e 2>&1   # expect per chosen option (a or b)
ls test/integration && echo "present (expected)"

echo "=== Phase 6 assertions ==="
rg -c 'session.startScreencast|onFrame callback' test/streaming/screencast.test.ts  # expect: >= 1
ls test/runtime/serve-errors.test.ts 2>&1   # expect: present (or merged into serve.test.ts)

echo "=== Test count vs baseline ==="
bun test 2>&1 | tail -3
```

The final test count should be approximately: baseline − 3 (phase 1 deletions) + 1 (phase 3 bindable) + ~4 (phase 6 screencast) + 3 (phase 6 serve) − (phase 7 consolidations, if any). Phase 2 (cli-adapter) may also adjust the count depending on Susan's decision.

- [ ] **Step 8.3: Verify the phase-boundary tags exist.**

```bash
git tag | rg 'pri-1630-phase-'
```

Expected: `pri-1630-phase-1` through `pri-1630-phase-7`, plus the two gate tags (`pri-1630-phase-2-gate`, `pri-1630-phase-5-gate`).

- [ ] **Step 8.4: Re-read the audit against the diff.**

```bash
git log --oneline main..HEAD
```

For each of the 11 items in `docs/notes/test-audit-2026-05.md`, confirm there's a commit (or a documented Phase 2/Phase 5 gate decision) that addresses it. Note any deferrals with a one-line reason.

- [ ] **Step 8.5: Move Linear ticket to In Review with a reflective comment.**

Per `linear-ticket-lifecycle`, transition PRI-1630 to In Review and post a reflective comment covering: what went smoothly, what was tricky, subjective experience, anything a reviewer should watch.

- [ ] **Step 8.6: Do NOT merge. Do NOT close.**

Per house convention (`feedback_no_prs.md` + `feedback_linear_never_close_tickets.md`):
- Susan / the human merges the feature branch to `main` with `--no-ff` after In Review.
- The executor never transitions PRI-1630 to Done / Canceled / Duplicate. In Review is the executor's last move.

---

## Verification matrix

| Phase | Negative assertion | Positive assertion |
|-------|--------------------|--------------------|
| 1 | 3 named tautologies absent from grep; `test/helpers/pick-free-port.test.ts` does not exist | `test/util/pick-free-port.test.ts` exists; `test/helpers/credential-fixture.ts` exists; 3 sites in `adapters/cli/adapter.test.ts` use the helper |
| 2 | (gated — survey commit landed) | survey section in this plan; no test deletions yet |
| 3 | (no test deleted) | `test/util/pick-free-port.test.ts` has the bindable assertion |
| 4 | `grep -l "function makeConfig" test/` returns 0 | `test/helpers/make-config.ts` exists; 4 files migrated; `test/helpers/api-test-app.ts` exists; ≥1 api file migrated (pilot) and ideally all 9 |
| 5 | (gated — decision committed) | rename complete per chosen option |
| 6 | (no test deleted) | screencast has start/stop/onFrame/save-file tests; serve has malformed-body/oversize/mid-flight tests |
| 7 | commit count from `pri-1630-phase-6..HEAD` ≤ 6 | parameterized consolidation lands or survey concludes "no consolidation found" |
| 8 | test count matches predicted (baseline − 3 + 1 + ~7 + N) | Linear In Review with reflective comment; all phase tags present |

## Risks and watch-points

- **Phase 0 baseline depends on PRI-1629.** If PRI-1629 hasn't merged when this plan runs, every phase past 0 is moot. Phase 0 surfaces this loudly.
- **Phase 2 is a hard gate.** The audit's framing of "incompatible APIs" was wrong; the executor must not delete based on the audit alone. Survey, surface, then act.
- **Phase 4 depends on PRI-1628 phase 2** — for rebase-conflict avoidance, not for correctness. If PRI-1628's executor hasn't reached phase 2, Phase 4 stops and asks Susan.
- **Phase 5 is a hard gate.** Rename-vs-relocate is a small taxonomy call that benefits from one round of human review.
- **Phase 6 mid-flight close test may be flaky on one runtime.** If it is, do not `.skip` it as a workaround. Root-cause: either the source contract doesn't hold cross-runtime (file a source ticket and weaken the assertion with a comment), or the test is racy (fix the race). Memory: `feedback_correct_over_cheap.md` — lead with the correct fix.
- **Phase 7 must respect the bound** (≤6 commits, ≤200 LOC removed). The audit said "audit"; the plan picks a concrete sub-task. If the survey finds nothing worth consolidating, accept that and move on. Memory: `feedback_proportionality_check.md`.
- **Branch hygiene:** each phase ends with `git tag pri-1630-phase-N` and `git fetch origin main && git rebase origin/main`. Concentrate rebase pain at phase boundaries, not at final merge.
- **Memory cues for the executor:**
  - `feedback_multi_agent_checkout_collision.md` — verify `git branch --show-current` before each commit; this plan runs on the `gauntlet-tests` worktree.
  - `feedback_no_prs.md` — no PRs; In Review is the last executor move.
  - `feedback_linear_never_close_tickets.md` — never transition to Done/Canceled/Duplicate.
  - `feedback_no_default_gated_safety_tests.md` — none of the new tests in Phase 6 are env-gated. They run on every `bun test`.
  - `feedback_proportionality_check.md` — Phase 7 is bounded; "audit" doesn't become "rewrite."
  - `feedback_no_manufactured_justifications.md` — `gauntlet-tests` worktree path is arbitrary; the plan does not invent a rationale for it.

## Out of scope

- **No test-runner config changes** (no `bunfig.toml` unit-vs-integration split, no coverage tool wiring).
- **No new e2e tier** beyond the rename in Phase 5. A real black-box e2e suite is a separate ticket.
- **No CI-time changes.**
- **No source changes** except via PRI-1628's plan (sibling work).
- **No documentation overhaul** for the test suite. If Phase 5's rename changes a doc reference, fix that reference; do not rewrite the docs.

---

## CLI-adapter test overlap survey (Phase 2, PRI-1630)

**Surveyor:** Surgeon@daef2708 · **Date:** 2026-05-18 · **Source state:** at `pri-1630-phase-1` tag.

### Public surface of `CLIAdapter` (`src/adapters/cli/adapter.ts`)

| Method | Role | Notes |
|---|---|---|
| `start(target)` | Spawns detached `bash -i` in `<runDir>/scratch`; attaches stdout/stderr readers. | Throws if `runDir` is not set. |
| `readOutput()` | Drains + clears the internal buffer. Called directly and via `executeTool("read_output")`. | |
| `describeTarget(target)` | Returns the system-prompt fragment describing the shell and (optionally) the target command. | Pure. |
| `defaultViewport()` | Returns `null` — CLI has no rendering surface. | Pure. |
| `type(text)` | Writes text to the shell's stdin. **Both** a public method and the dispatch target of `executeTool("type")`. | |
| `press(key)` | Maps a key name through `KEY_MAP`, calls `type()`. | |
| `close()` | `killProcessTree(pgid, descendants)`; emits `cli_shell_descendants_reaped` when descendants were reaped. | Logs only when `logger` was injected. |
| `isMutatingTool(name)` | Host's mutation gate (`"type"` and `"press"` only). | Pure. |
| `toolDefinitions()` | Lists `type`/`press`/`read_output` plus the shared tools (`read`, `fetch_credential`, `bash`) conditional on options. | |
| `executeTool(name, args, logger)` | Validates `args` against the tool schema; dispatches shared tools first, then `type`/`press`/`read_output`. | |

The audit's "incompatible APIs" framing was wrong: both `type()` and `executeTool("type", ...)` route to the same code, and both are intentionally public.

### `test/adapters/cli-adapter.test.ts` — integration angle

| Test | Entry point | Dependency style | Behavior pinned |
|---|---|---|---|
| `start() creates <runDir>/scratch and runs bash there` | `start`, `executeTool("type"/"read_output")` | real `EvidenceLogger`, real bash via real `runDir` | scratch dir exists; shell's `pwd` is the scratch dir |
| `describeTarget mentions the shell and the target command` | `describeTarget` | pure | with-target string content |
| `describeTarget omits the target sentence when target is empty` | `describeTarget` | pure | without-target string content |
| `orphan reap: backgrounded sleep is gone after close and event fires` | `start`, `executeTool("type"/"read_output")`, `close` | real logger, real bash, real PID check via `process.kill(pid, 0)`, real `run.jsonl` read | real backgrounded sleep PID dies on close; `cli_shell_descendants_reaped` lands in `run.jsonl` |
| `no event emitted when there are no descendants to reap` | `start`, `close` | real logger, `run.jsonl` read | clean close emits no reap event |
| `half-typed line: close still exits cleanly` | `start`, `executeTool("type")`, `close` | real logger, real bash | close doesn't throw with a half-typed line in the buffer |
| `agent can drive an interactive prompt-and-answer script` | `start`, `executeTool("type"/"read_output")` | real logger, real bash, real on-disk shell script with `chmod 0755` | multi-step prompt-response over the same shell session |

**Classification:** every test in this file starts a bash shell and asserts a real side-effect (filesystem, PIDs, `run.jsonl`). All dispatch through `executeTool`. This file is an integration suite.

### `test/adapters/cli/adapter.test.ts` — API-contract angle

| Test | Entry point | Dependency style | Behavior pinned |
|---|---|---|---|
| `starts a shell and reads output` | `start`, `adapter.type` (direct), `readOutput` (direct) | mock logger, real bash (`echo`) | shell starts, `echo` output appears in buffer |
| `sends input and reads response` | `start`, `adapter.type` (direct), `readOutput` (direct) | mock logger, real bash (`cat`) | input echo-back via `cat` |
| `exposes tool definitions for the agent` | `toolDefinitions` | mock logger | `type`/`press`/`read_output` registered |
| `includes read tool when context root is non-empty` | `toolDefinitions` | mock logger, real tmp dir | conditional `read` registration |
| `executeTool(read) returns file contents via the read tool` | `executeTool("read")` | mock logger, real tmp dir | shared `read` tool wired through `executeTool` |
| `defaultViewport returns null` | `defaultViewport` | pure | null return |
| `describeTarget frames the agent as inside a bash shell` | `describeTarget` | pure | with-target string content (same shape as cli-adapter.test.ts) |
| `registers fetch_credential when contextRoot and credentialResolver set` | `toolDefinitions` | mock logger, `withCredentialFixture` | conditional `fetch_credential` registration (positive) |
| `omits fetch_credential when credentialResolver is undefined` | `toolDefinitions` | mock logger, `withCredentialFixture` | negative case 1 |
| `omits fetch_credential when contextRoot is empty even if resolver is set` | `toolDefinitions` | mock logger, `withCredentialFixture` | negative case 2 |
| `toolDefinitions includes bash` | `toolDefinitions` | mock logger | `bash` shared tool registered |

**Classification:** mostly tool-definition introspection (no shell spawned). The first two tests (`starts a shell`, `sends input`) are the outliers — they spawn a real bash and exercise `adapter.type()` directly, bypassing `executeTool`. They overlap with the cli-adapter.test.ts coverage of the same start-and-read code path.

### Overlap analysis

Three concrete overlaps, all between `cli/adapter.test.ts` and the stronger coverage in `cli-adapter.test.ts`:

1. **Shell start + read** — `cli/adapter.test.ts:24-33` (`starts a shell and reads output`) is a weaker version of `cli-adapter.test.ts:35-50` (`start() creates <runDir>/scratch and runs bash there`). The cli-adapter.test.ts version asserts the scratch dir exists and `pwd` matches; the cli/adapter.test.ts version only asserts the buffer contains a substring.
2. **Stdin -> buffer round-trip via direct `type()`** — `cli/adapter.test.ts:35-45` (`sends input and reads response`) overlaps the `executeTool("type", ...)` paths exercised throughout cli-adapter.test.ts (the prompt-response and reap tests both round-trip stdin through to `readOutput`). The substring-only assertion adds nothing.
3. **describeTarget with target** — `cli/adapter.test.ts:99-105` overlaps `cli-adapter.test.ts:52-58` exactly. cli-adapter.test.ts also covers the without-target case (line 60-65) that cli/adapter.test.ts doesn't.

No test is dead-coding a removed path. `adapter.type()` is still publicly part of the `Adapter` contract (matches `WebAdapter.type()` and the host's mutation-replay code path), so even after these deletions the method stays in `src/`.

### Recommended action

**Option (a) — Keep both files; tighten by deleting 3 overlapping tests from `cli/adapter.test.ts`.**

Specifically:
- Delete `starts a shell and reads output` (lines 24-33)
- Delete `sends input and reads response` (lines 35-45)
- Delete `describeTarget frames the agent as inside a bash shell` (lines 99-105)

Net: `cli/adapter.test.ts` becomes a pure API-contract suite (tool-set composition, conditional registration, viewport, `executeTool("read")` wiring). `cli-adapter.test.ts` remains the integration suite (real bash, real `run.jsonl`, real PIDs). The two angles stay; the boundary becomes clean.

**Test count delta if approved:** −3.

This is the survey's recommended action. The executor will not apply it without Susan's sign-off.
