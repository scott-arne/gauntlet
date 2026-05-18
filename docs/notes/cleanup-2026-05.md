# Gauntlet house-cleaning pass — 2026-05-18

Author: Susan@280d483a · scope: wide-and-shallow assessment of `src/`
LOC surveyed: ~14k TypeScript across `src/` (129 test files mirror under `test/`)
Method: direct reads of entrypoints + module bones; three parallel sub-agent sweeps
(Cartographer — dependency map; Schematic — type system; Archaeo — pattern split).

## Erratum (added 2026-05-18 after independent verification)

Found while re-verifying before dispatching the executor: this audit's "Dead
exports" claim under "Smaller observations" is **wrong on two of three items**.

- **`READ_TOOL_DESCRIPTION` is NOT dead** — `test/context/read-tool.test.ts:5,21`
  imports it and asserts the description matches a spec constant.
- **`FETCH_CREDENTIAL_TOOL_DESCRIPTION` is NOT dead** — `test/context/credential-tool.test.ts:8,138`
  imports it and asserts the tool's description matches.
- **`BASH_TOOL_DESCRIPTION` is dead** — verified, used only inside its own file.

Archaeo's grep was scoped to `src/` only; the test imports were missed and the
audit inherited the error. Same root cause as the parallel mistake in
`test-audit-2026-05.md` (see its erratum). The PRI-1628 plan's Task 1.1 has
been corrected to drop only the one truly-dead export.

Lesson, same as for the test audit: when sub-agents report "X is unused
anywhere," verify the grep scope before publishing.

## TL;DR

The bones are **good**. No cycles, no major layering violations, tests mirror source,
no `export default` anywhere, no `any` field-level leakage worth panicking about, type
strictness is on, and reach-arounds are rare (one in `cards/store.ts`).

The drift is in **three concentrated places**:

1. **Three near-identical "run config" types** — `RunConfigSnapshot`, `EffectiveRunConfig`,
   `RunCoreConfig`. Same concept, different rooms.
2. **Three error-handling styles coexist** — `ParseResult<T>` (validators), `throw`/`catch`
   (utility code), `{ error: string }` discriminated unions (some routes).
3. **Three composition styles coexist** — classes (adapters), factory closures (tools),
   bare module functions (server/cards/orchestrator). Each is fine in isolation; the
   recent `shared-tools` refactor implicitly elected the factory-closure style without
   the adapters following.

Plus a clutch of smaller observations (naming inconsistency `runDir`/`outDir`, no
branded ids, `VetResult` and `ToolResult` are crying out to be discriminated unions,
`config.ts` and `cli/args.ts` are full of repetitive env+flag+default machinery).

None of this is urgent. **All of it is the kind of mess that compounds.**

---

## Module map at a glance

```
src/
├── index.ts          (218 LOC) — CLI dispatcher; uses dynamic imports per command
├── config.ts         (677 LOC) — AppConfig, env+flag merging; heaviest root file
├── types.ts          (124 LOC) — VetResult, Observation, RunConfigSnapshot
├── paths.ts          (135 LOC) — path-safety; the one and only containment guard
│
├── adapters/         — web / cli / tui; classes implementing Adapter interface
│   ├── adapter.ts          — Adapter interface + AdapterType
│   ├── registry.ts         — getAdapterToolDefinitionsByName (revival lookup)
│   └── {web,cli,tui}/adapter.ts
├── agent/            — agent loop, shared tools, prompts, validators
├── api/              — Hono server, routes, websockets
├── cards/            — story-card storage
├── cli/              — CLI commands (run, batch, ask, fanout, validate, config)
├── context/          — read-tool, credential-tool, context-tree rendering
├── evidence/         — JSONL logger, result writer, run-set writer
├── fanout/           — story-card generator
├── format/           — story-card parser (pure)
├── models/           — anthropic, openai, provider abstraction, resolve
├── revival/          — message-replay for session inspection
├── runs/             — orchestrator, run-set, snapshot, aggregate
├── runtime/          — process-tree, serve, spawn (Node/Bun compat seam)
├── streaming/        — screencast frames over WS
└── util/             — id, parse-duration, pick-free-port, sanitize-error
```

**Cycle audit:** none. Verified `adapters ↔ agent`, `api ↔ cli`, `revival ↔ agent`,
`evidence ↔ runs` — all unidirectional.

**Reach-arounds:** one. `src/cards/store.ts:5` imports `ErrorLog` from
`../api/routes/errors`. `cards` is a low-level module; `api/routes` is a leaf
under a higher-level module. Either re-home `ErrorLog` (it's just a type) into
`cards/` or `util/`, or invert the dependency.

**Test layout:** `test/` mirrors `src/` by directory. Healthy.

---

## Top concerns (ranked by leverage × ease)

### 1. Config-type triplication

Three types describe substantially the same thing:

| Type | Home | Fields | Role |
|------|------|--------|------|
| `RunConfigSnapshot` | `src/types.ts:27` | target, model, adapter, chrome?, budgetMs, viewport? | Serialized into `result.json` (back-compat surface) |
| `EffectiveRunConfig` | `src/config.ts:158` | + saveScreencast, projectRoot, reflectionInterval, credentialResolver | Post-merge of AppConfig + RunRequestBody |
| `RunCoreConfig` | `src/runs/orchestrator.ts:43` | EffectiveRunConfig minus saveScreencast | What `executeRunCore` actually takes |

EffectiveRunConfig → RunCoreConfig is a manual, one-line transformation that drops
`saveScreencast`. The drop is itself suspicious — why doesn't the orchestrator know
whether to save the screencast?

**Recommendation:** collapse `EffectiveRunConfig` and `RunCoreConfig` into one
"resolved run config." Keep `RunConfigSnapshot` distinct because it's a
versioned wire format with a `RESULT_SCHEMA_VERSION` discipline — but derive it
from the resolved type explicitly (`function snapshotRunConfig(rc: RunConfig):
RunConfigSnapshot`) so the field set is single-sourced.

**Effort:** small (touches `config.ts`, `orchestrator.ts`, the call sites in
`cli/run.ts`, `cli/batch.ts`, `api/routes/run.ts`). **Risk:** low — types only.

### 2. Repetitive parser bloat in `config.ts` and `cli/args.ts`

`config.ts` is 677 lines, of which roughly **400 are repetitions of**:

```ts
let foo = DEFAULT_FOO;
let fooSource: "default" | "env" | "flag" = "default";
if (env.GAUNTLET_FOO) { foo = parseFoo(env.GAUNTLET_FOO, "GAUNTLET_FOO"); fooSource = "env"; }
if (args.foo !== undefined) { foo = parseFoo(args.foo, "--foo"); fooSource = "flag"; }
```

There are ~15 such blocks. They differ only in: (a) the default, (b) the parser, and
(c) whether `args` participates (some are env-only operator knobs).

Source-attribution is **valuable** — `gauntlet config` shows where each value came
from, and `mergeRunConfig` uses `sources.defaultChrome === "default"` to decide
whether to auto-launch Chrome. Don't lose that.

**Recommendation:**

```ts
function resolveSetting<T>(spec: {
  env?: { name: string; parse: (raw: string) => T };
  arg?: { value: unknown; parse: (raw: any) => T };
  default: T;
}): { value: T; source: "default" | "env" | "flag" };
```

15 hand-rolled blocks → 15 small specs + one combinator. Shrinks the file by
~300 lines and eliminates a class of bug (forgetting to set `*Source`).

**Same pattern, smaller scale, in `cli/args.ts`** — `parseIntFlag`, `parseBoolFlag`,
`parsePasses` are each isolated, but the per-command "allowed flags" sets
(`RUN_ALLOWED`, `BATCH_ALLOWED`, `VALIDATE_ALLOWED`, `FANOUT_ALLOWED`,
`SERVE_ALLOWED`, `CONFIG_ALLOWED`, `ASK_ALLOWED`) plus the `rejectUnknownFlags`
discipline could move into a small per-command spec object.

**Effort:** medium (one careful refactor; tests already cover the matrix). **Risk:**
medium — config behavior is load-bearing and `sources` provenance is consumed by
`mergeRunConfig`. The shape change must preserve `AppConfig.sources` exactly.

### 3. Three error-handling styles coexist

| Style | Where | Example |
|-------|-------|---------|
| `ParseResult<T>` (`{ ok, value } \| { ok, reason }`) | `agent/validators.ts`, `context/credential-tool.ts` (as `ResolverResult`) | `parseReportResult(args)` |
| `throw` / `try-catch` | `cards/store.ts`, `api/server.ts`, route handlers | `JSON.parse` wrappers |
| `T \| { error: string }` discriminated by `"error" in x` | `api/routes/fanout.ts:14` | `resolveClient` |

This is **not broken** — each style is self-consistent inside its domain. But the
fragmentation taxes the reader and means new code has no clear default.

**Recommendation:** pick one. The `ParseResult<T>` shape is the strongest — it's
exhaustively narrowable, costs nothing to construct, and `validators.ts` already
defines it. Use it for any function whose failure is a normal expected outcome
(parsing, validation, lookups). Keep `throw` for genuinely exceptional failures
(disk I/O, network) and at process boundaries. Retire the ad-hoc
`{ error: string }` shape in route helpers.

Document the rule in one paragraph in `CONTRIBUTING.md` or similar.

**Effort:** small for the doc; medium if you actually migrate the three styles.
**Risk:** low — local refactors, easy to review.

### 4. `VetResult` and `ToolResult` want to be discriminated unions

`VetResult.error` is optional today but is morally required when
`status === "errored"`. Typed as a DU:

```ts
type VetResult =
  | (VetResultBase & { status: "pass" | "fail" | "investigate" })
  | (VetResultBase & { status: "errored"; error: { type: string; message: string } });
```

…would let the compiler enforce "if errored, there's an error field." Same shape
upgrade applies to `ToolResult` (today: `text` plus six optionals; really 3–4
distinct shapes — text-only, with-image, with-artifact, with-capture).

**Recommendation:** convert `VetResult` first (smaller blast radius — one writer
in `agent.ts`, one schema-version bump on the way out). `ToolResult` is larger
because every adapter produces it and the agent reads field-by-field; do it later
if at all.

**Effort:** `VetResult` small, `ToolResult` medium. **Risk:** low — non-breaking
on the JSON wire (additive narrowing).

### 5. Composition-style split

Three styles coexist:

- **Classes:** `WebAdapter`, `CLIAdapter`, `TUIAdapter`, `EvidenceLogger`,
  `RunBroadcaster`, `ActiveRunRegistry`, `RunSetBroadcaster`, `CancelTokenRegistry`,
  `ShutdownState` (api).
- **Factory closures:** `buildSharedTools`, `buildReadTool`, `buildBashTool`,
  `buildFetchCredentialTool`, `buildInstallPasskeyTool`, `buildInstallCookiesTool`.
- **Bare module functions:** `createApp`, `findCard`, `loadAllCards`, `executeRunCore`.

The factory-closure style was introduced recently (shared-tools, bash-tool) and
is genuinely nicer for the "tool" abstraction — small, no inheritance, easy to
test, no `this` foot-guns. The adapter classes don't really earn the class
(`WebAdapter` has no `extends`, no protected members, no polymorphism beyond
`implements Adapter`).

**Recommendation:** no urgent action. But if `web/adapter.ts` (1257 LOC) gets
touched for any other reason, consider converting it to a factory closure as
part of the change. Don't refactor for refactoring's sake.

---

## Smaller observations

- **`runDir` vs `outDir`.** Same directory, two names. Adapters say `runDir`;
  orchestrator/CLI say `outDir`. The `outDir`-shaped name is older (`out` flag).
  Pick one — `outDir` reads cleaner.

- **No branded ids.** `runId`, `cardId`, `runSetId` are all bare `string`. Three
  identifiers passed through many layers, easy to transpose. Brands would catch
  swaps at compile time for ~30 lines of declaration cost. Worth doing.

- **`adapters/web/adapter.ts` is 1257 LOC** — the largest single file in the
  repo. It already has a `lib/` subdirectory (`passkey.ts`, `cookies.ts`,
  `page-scripts/`). The adapter itself could likely shed 200–400 LOC into
  per-capability files under `web/lib/`.

- **`evidence/logger.ts` carries a legacy channel.** The `addObserver` /
  `notifyObservers` action-observer pair predates the newer
  `addEventObserver` channel; both fire side-by-side and the older is marked
  "legacy" in comments (`logger.ts:166`). Decide: is the action-observer being
  kept indefinitely for compat, or is there a planned retirement? If the
  former, drop "legacy"; if the latter, file a ticket and a deadline.

- **Dead exports.** `READ_TOOL_DESCRIPTION`, `BASH_TOOL_DESCRIPTION`,
  `FETCH_CREDENTIAL_TOOL_DESCRIPTION` are exported from their respective tool
  files but used only inside the same file. Drop the `export`.

- **Dynamic imports in `index.ts`.** Every command branch does
  `await import("./cli/foo")` rather than top-level imports. This is either a
  deliberate startup-time win (the CLI is invoked many ways and most commands
  don't need most modules) or a copy-paste habit. If deliberate, it's worth a
  one-sentence comment at the top of `main()`. If not, consolidate.

- **Tool description constants** are defined as module-level `const NAME = "..."`
  and embedded back into the same module's tool definition. Inlining them
  would lose nothing.

- **`config.ts`'s `validateRunBody` has a `Record<string, never>` opts
  parameter** (`config.ts:211`). Either ditch it (it's never used) or make
  it a real options type for forward-compat. The current shape is the worst
  of both worlds.

- **`isMutatingTool` is on every adapter** as a 1–2 line classification. If
  the set ever grows, consider moving it to a per-tool field on `ToolDefinition`
  instead of a method on the adapter (data over methods for static
  classification).

- **`runtime/`, `streaming/`, `util/` have zero cross-module imports.** That's a
  good sign — they're properly isolated leaves. Worth protecting (e.g., a
  lint rule or a brief note in CONTRIBUTING).

---

## Candidate refactor list (with effort × risk)

| # | Refactor | Effort | Risk | Leverage |
|---|----------|--------|------|----------|
| 1 | Collapse `EffectiveRunConfig` + `RunCoreConfig`; derive `RunConfigSnapshot` | S | L | high |
| 2 | Extract `resolveSetting<T>` combinator in `config.ts` | M | M | high |
| 3 | `VetResult` → discriminated union on `status` | S | L | medium |
| 4 | Pick one error-handling style; document; migrate stragglers | M | L | medium |
| 5 | Brand `runId`/`cardId`/`runSetId` | S | L | medium |
| 6 | Rename `runDir` → `outDir` everywhere (or vice versa) | S | L | low |
| 7 | Split `adapters/web/adapter.ts` into per-capability files | M | M | medium |
| 8 | Re-home `ErrorLog`; fix the `cards → api/routes` reach-around | XS | L | low |
| 9 | Decide action-observer's fate; either rename or retire | S | L | low |
| 10 | Drop dead exports (`*_TOOL_DESCRIPTION`) | XS | L | low |
| 11 | `ToolResult` → discriminated union | M | M | medium |

Pairings that compound:

- **(1) + (3)** is a natural single PR: both touch result/config shape and the
  same call sites.
- **(2) + the args-parser cleanup** could land together as a single
  "config plumbing tidy."
- **(8) + (10) + (9 partial)** is a single afternoon's worth of small-tidy work.

---

## What I'd start with

If you want one PR worth of effort: **(1) + (3)** — collapses the
config-type triplication and lands `VetResult` as a discriminated union. Both
are type-level, both have full test coverage already, and both pay off every
time someone touches the run lifecycle in the future.

If you want a half-day of small-tidy: **(8) + (10) + (6)** — re-home `ErrorLog`,
drop dead exports, pick `outDir` vs `runDir`. None of it is hard; together it
removes a slow drag on every file read.
