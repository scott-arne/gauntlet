# Shared run orchestrator - design

**Status:** revised draft after Bob review (Cordelia, 2026-05-05).
**Author:** Codex; revisions by Cordelia.
**Linear:** PRI-1481
**Related:** `src/cli/run-one.ts`, `src/cli/run.ts`, `src/cli/batch.ts`, `src/api/routes/run.ts`, `src/runs/run-set.ts`, `src/evidence/logger.ts`, `docs/superpowers/specs/2026-04-21-expanded-run-log-design.md`, `docs/superpowers/specs/2026-04-29-multi-pass-runs-design.md`

---

## Problem

Gauntlet currently has two product surfaces that run the same agent loop:

- CLI: `gauntlet run` and `gauntlet batch`, centered on `src/cli/run-one.ts`.
- Web product: `POST /api/run/:id`, centered on `src/api/routes/run.ts`.

Both paths assemble a run lifecycle from the same ingredients: snapshot run
inputs, create an `EvidenceLogger`, render the immutable context tree, create
and start an adapter, create an LLM client, call `runAgent`, stamp result
metadata, write result files, and close resources.

The duplication is not harmless. New run-level behavior has to be threaded
through both paths, and current route code already has separate solo and
multi-pass assembly blocks. That makes future config, evidence, and lifecycle
changes easy to apply to one surface but not the other.

## Factual corrections to PRI-1481

PRI-1481 is right about the duplicated orchestration, but a few details should
be corrected before implementation:

1. **`log.jsonl` is not the core run transcript.** The canonical per-run
   transcript is `run.jsonl`, written by `EvidenceLogger.writeEvent` and used
   by both CLI and HTTP runs.
2. **`log.jsonl` is a browser-event sidecar, not a CLI-only artifact.**
   The expanded run-log spec explicitly leaves `console.jsonl`,
   `exception.jsonl`, `log.jsonl`, and `network-ws.jsonl` unchanged as
   WebAdapter observer sidecars. A run gets those files only when the web
   adapter observer emits those browser event categories.
3. **The web product path does not merely reimplement `runOne`.** Its
   `executeRun` function also owns HTTP-specific behavior: detached execution,
   WebSocket progress and structured event fanout, active-run registry updates,
   screencast streaming, terminal broadcasts, and unregister ordering.
4. **`mergeRunConfig` is HTTP-specific today.** CLI uses resolved
   `AppConfig` defaults directly. The refactor should not force HTTP request
   body validation or allow-list checks into the core orchestrator.

## Goal

Extract one shared run-core orchestrator that owns the product-independent
single-run lifecycle while keeping CLI and HTTP responsible for their own
surface behavior.

After the refactor, there should be exactly one implementation of:

- Run input snapshotting.
- Per-run evidence logger creation.
- Context tree rendering from the snapshotted context.
- Adapter construction and start/close lifecycle.
- LLM client creation or injection.
- `runAgent` invocation.
- Result metadata stamping.
- `writeResultFiles`.
- Error-event logging.

## Non-goals

- No web UI redesign.
- No change to the `run.jsonl` schema.
- No change to browser sidecar logs.
- No change to `RunSet` disk schema.
- No concurrency changes for multi-pass runs.
- No forced unification of HTTP request parsing with CLI option parsing.
- No removal of `runOne` if a thin compatibility shim keeps callers cleaner.

## Current state

### CLI single run

`src/cli/run.ts` calls `runOne` for a single card and passes an `onLogger`
hook that attaches the CLI stream renderer.

`runOne` parses the story file, generates a run id, snapshots inputs, creates
an `EvidenceLogger`, creates a client, builds an adapter, starts it, calls
`runAgent`, stamps `result.config` and optional `result.runSet`, writes result
files, logs `run_error` on thrown errors, and closes the adapter.

### CLI batch and multi-pass

`src/cli/run.ts` and `src/cli/batch.ts` use `runRunSet` for grouped work.
Their executor calls `runOne` for each constituent run and uses the same
`onLogger` hook shape to update tables or JSONL stdout.

### HTTP single run

`src/api/routes/run.ts` validates the request body, merges HTTP overrides with
server config, enforces the model allow-list, creates a client, pre-registers
the active run, then starts `executeRun` in the background and returns `202`.

The route manually duplicates the run assembly that `runOne` already performs.

### HTTP multi-pass

For `passes > 1`, the route uses `runRunSet` and supplies an executor that
again manually snapshots inputs, creates a logger, builds an adapter, renders
the context tree, and calls `executeRun`.

### HTTP executeRun

`executeRun` starts the adapter, optionally starts screencast streaming,
bridges logger observers to WebSocket and registry updates, calls `runAgent`,
writes results, broadcasts terminal completion/error, unregisters the active
run, and closes resources.

This contains both duplicated run-core work and HTTP-only product behavior.

## Design

Create `src/runs/orchestrator.ts` as the shared run-core module. It should
export a function tentatively named `executeRunCore`.

`executeRunCore` is product-independent. It returns a `RunOneSummary`-like
value and does not know about Hono, WebSocket broadcasters, active-run
registries, run-set broadcasters, HTTP response shape, CLI stdout rendering, or
cancel-token registries.

Product surfaces customize behavior through hooks.

```ts
export type RunAdapterType = "web" | "cli" | "tui";

export interface RunCoreConfig {
  projectRoot: string;
  model: string;
  adapter: RunAdapterType;
  target: string;
  turns: number;
  /**
   * Already-resolved Chrome endpoint, or `undefined` to let WebAdapter
   * auto-launch. Surface code is responsible for collapsing
   * `AppConfig.sources.defaultChrome === "default"` to `undefined` before
   * calling the core. The core never inspects config-source semantics.
   */
  chrome?: ChromeEndpoint;
  viewport?: Viewport;
}

export interface RunCoreHooks {
  /**
   * Attach observers/renderers to the freshly-constructed logger. Return a
   * detach function; the core invokes it after `adapter.close()` so that
   * close-time events still fan out through any wrapper observers.
   */
  onLogger?: (logger: EvidenceLogger, ctx: RunCorePrepared) => void | (() => void);
  beforeAgent?: (ctx: RunCoreStarted) => Promise<void> | void;
  onError?: (err: unknown, ctx: RunCoreStarted | RunCorePrepared) => Promise<void> | void;
  beforeClose?: (ctx: RunCoreStarted) => Promise<void> | void;
  afterClose?: (ctx: RunCoreStarted | RunCorePrepared) => Promise<void> | void;
}

export interface ExecuteRunCoreOptions {
  card: StoryCard;
  storyPath: string;
  runId?: string;
  outDir?: string;
  runConfig: RunCoreConfig;
  runSetCtx?: RunSetCtx;
  /**
   * Already-built LLM client. Surfaces resolve provider, enforce
   * allow-lists, and construct the client before calling the core so that
   * config errors surface synchronously (HTTP needs this for 400 responses,
   * CLI needs this for early process exit).
   */
  client: LLMClient;
  hooks?: RunCoreHooks;
}

export interface ExecuteRunCoreResult {
  runId: string;
  outDir: string;
  result: VetResult;
}
```

The exact exported names may change during implementation, but the boundary
should hold: the core takes a parsed `StoryCard`, a story path for snapshotting,
effective run config, an already-built client, optional run identity, and
hooks.

The Chrome profile name (`gauntlet-run-${runId}`) is derived inside the core
from `runId`. Surfaces never pass a profile name in.

## Lifecycle contract

`executeRunCore` performs these steps in this order:

1. Determine `runId`.
2. Determine `outDir`.
3. Snapshot story and context into `<outDir>/inputs`.
4. Create `EvidenceLogger`.
5. Attach logger hooks (call `onLogger`, capture detach fn).
6. Render context tree from `<outDir>/inputs/context`.
7. Create adapter.
8. Start adapter.
9. Snapshot viewport from started adapter into `runConfig` for `result.config`.
10. Run `beforeAgent` hooks.
11. Call `runAgent`.
12. Stamp `result.config` (includes viewport from step 9).
13. Stamp `result.runSet` when provided.
14. Write result files.
15. On error, write `run_error` to `run.jsonl`, call `onError`, then continue to cleanup; rethrow after cleanup.
16. Run `beforeClose`.
17. Close adapter.
18. Detach logger hooks.
19. Run `afterClose`.

Adapter close and logger detach must happen in `finally`. Logger detach
runs *after* adapter close so that any events emitted during adapter
shutdown still fan out through wrapper-installed observers.

## Intentional behavior changes

The refactor is not strictly behavior-preserving on the HTTP path. The
following changes are deliberate and unify the contract across surfaces:

1. **HTTP runs gain `run_error` events in `run.jsonl`.** Today only CLI's
   `runOne` writes `run_error` on thrown errors. Current HTTP `executeRun`
   only writes to `ErrorLog` and emits a terminal WS `error` event. After
   the refactor, both surfaces emit `run_error` to evidence; HTTP terminal
   broadcast and `ErrorLog` writes remain wrapper-level concerns.
2. **HTTP logger observers detach *after* adapter close.** Today HTTP
   detaches observers as the first step of `finally` (before
   `adapter.close()`), so any logger events emitted during adapter shutdown
   are silently swallowed by the broadcaster. After the refactor, those
   close-time events fan out. WebAdapter observer-session flush events are
   the most likely to be visibly affected.
3. **HTTP viewport snapshot moves from pre-start to post-start.** Today
   HTTP builds `runConfig.viewport` at adapter construction time
   (pre-`start`); CLI builds it post-`start`. The unified core takes the
   CLI ordering. As of today the snapshotted value is identical in both
   orderings — `WebAdapter.defaultViewport()` returns the
   constructor-supplied value, not a CDP query — so this is a unification
   of ordering, not a correctness fix. Post-start is the right anchor if
   `defaultViewport()` ever becomes CDP-derived. Implementer should still
   run `bun test test/api/run.test.ts` and check viewport assertions hold;
   the unification, not the value, is the contract change.

If any of these turn out to be unsafe, surface-specific mitigation belongs
in the wrapper, not by reverting the core's lifecycle.

## Hook guidance

Hooks must be narrow and observable. A hook may add side effects around the
core lifecycle, but it should not replace the core lifecycle.

### CLI hooks

CLI uses `onLogger` to attach:

- Pretty stream renderer for `gauntlet run`.
- JSONL stream output for `--format jsonl`.
- Batch table updates for batch and multi-pass runs.

CLI should not need hooks for registry, terminal WebSocket events, or
screencast frames.

### HTTP hooks

HTTP uses hooks to attach:

- Legacy progress fanout from `logger.addObserver`.
- Structured event fanout from `logger.addEventObserver`.
- Registry progress recording.
- Screencast streamer start/stop for web adapter runs.
- Terminal broadcast after registry unregister.

The active-run registry remains route-level state. The core should not
pre-register, unregister, or know that a registry exists.

## HTTP wrapper

Rename HTTP `executeRun` to `executeHttpRun` and keep it in or near
`src/api/routes/run.ts`. The new name removes ambiguity with
`executeRunCore`.

The wrapper owns:

- Progress observer setup (`onLogger` hook).
- Event observer setup (`onLogger` hook).
- Screencast streamer start (`beforeAgent` hook for web adapter runs).
- Screencast streamer stop (`beforeClose` hook).
- Error log writes to `ErrorLog` (`onError` hook).
- Registry unregister + terminal `complete`/`error` broadcast
  (`afterClose` hook), preserving the current "unregister before broadcast"
  ordering so a late-connecting WebSocket sees an empty registry.

This wrapper calls `executeRunCore` with hooks. It must not duplicate
snapshot, logger, adapter, context tree, `runAgent`, or result-writing
logic.

`executeHttpRun` returns the `ExecuteRunCoreResult` from the core. The
multi-pass executor uses that return value directly; the current
`readFileSync` of `result.json` after `executeRun` (multi-pass executor in
`src/api/routes/run.ts`) is removed.

The solo route keeps the current detach behavior:

1. Validate request.
2. Merge HTTP run config.
3. Enforce allow-list.
4. Resolve provider and build the LLM client (so config errors are
   synchronous 400s, not detached crashes).
5. Generate run id.
6. Register active run.
7. Fire `executeHttpRun(...).catch(...)` in the background.
8. Return `202`.

The multi-pass route keeps `runRunSet` and uses an executor that calls
`executeHttpRun` for each attempt. The executor body must be a thin
adapter — no inline snapshot, logger, adapter construction, context tree
rendering, or `result.json` read-back. (Acceptance check: executor body
≤25 lines.)

## CLI wrapper

Keep `runOne` as the CLI-compatible entry point unless implementation proves a
direct replacement is cleaner.

After the refactor, `runOne` should:

1. Read and parse the story card.
2. Build the LLM client via `createClient(config.models.agent)`.
3. Collapse `config.sources.defaultChrome === "default"` to
   `chrome: undefined`; otherwise pass `config.defaultChrome` through.
4. Translate `RunOneOptions` to `ExecuteRunCoreOptions`.
5. Pass the existing `onLogger` hook through (lifted into
   `RunCoreHooks.onLogger`).
6. Return the `ExecuteRunCoreResult`.

No adapter construction, snapshotting, context tree rendering, or
`runAgent` call should remain in `runOne`.

## Logging contract

Both CLI and HTTP runs must continue to write `run.jsonl` for every run.

Browser sidecar logs remain unchanged:

- `console.jsonl`
- `exception.jsonl`
- `log.jsonl`
- `network-ws.jsonl`

Those sidecars are emitted by `WebAdapter` observer sessions when a web run has
an `EvidenceLogger`. They are not a CLI-only behavior and they are not an HTTP
transcript substitute.

The refactor must preserve `run.jsonl` event order for a normal completed run:

1. `run_start`
2. `system_prompt`
3. `user_message`
4. Per-turn model and tool events.
5. `run_end`

On thrown errors, the core logs `run_error` and rethrows. HTTP wrappers may
convert that throw into terminal broadcast behavior, but the core still records
the error in evidence.

## Config contract

HTTP continues to use:

- `validateRunBody`
- `mergeRunConfig`
- model allow-list enforcement

CLI continues to use the resolved `AppConfig` and command flags.

The shared core should accept an already-effective config object. It should
not decide whether a config value came from defaults, env, flags, or HTTP body.

The core must preserve the important Chrome endpoint rule:

- If no Chrome endpoint was explicitly configured, pass `undefined` to
  `WebAdapter` so it can auto-launch.
- If an endpoint was explicitly configured, pass that endpoint through.

## RunSet contract

`runRunSet` remains the group orchestrator. The new core only runs one
attempt.

For CLI and HTTP multi-pass:

- `runRunSet` still generates all run ids up front.
- Each executor invocation passes its assigned `runId` into the shared core.
- Each executor passes `runSetCtx` into the shared core.
- The core stamps `result.runSet`.
- Existing `RunSetWriter` behavior is unchanged.

## Error handling

Core errors should behave like current CLI `runOne`: record `run_error`, close
resources, and reject.

HTTP wrappers should preserve current user-visible behavior:

- The HTTP request has already returned `202`.
- A thrown run error is captured as a terminal WebSocket error.
- `ErrorLog` receives the run-scoped message.
- The active-run registry unregister happens before terminal broadcast.
- Adapter close errors and streamer stop errors are swallowed during cleanup.

The spec intentionally preserves that asymmetry: CLI callers receive the thrown
error directly, while HTTP callers receive it through live-run state.

## Testing requirements

Add `test/runs/orchestrator.test.ts` for the shared core:

- Core snapshots story and context into the run input directory.
- Core starts and closes a stub adapter exactly once.
- Core writes `result.json` and `run.jsonl`.
- Core stamps `result.config`.
- Core stamps `result.runSet` when provided.
- Core invokes `onLogger` and detaches it in `finally` *after* adapter
  close (verify ordering by recording call sequence).
- Core logs `run_error` and rethrows when adapter start or agent execution
  fails.
- **Boundary test (negative coverage):** core never references a
  broadcaster, active-run registry, screencast streamer, or HTTP
  response. Enforce by passing no such dependencies and asserting the
  stub adapter and stub logger see all interactions.

Update CLI tests:

- Existing `test/cli/run-one.test.ts` still passes.
- Add a test proving `runOne` delegates to the core behavior and preserves
  parse failure behavior: invalid story cards should fail before logger hooks.

Update HTTP tests:

- Existing `test/api/run.test.ts` still passes.
- Existing `test/api/run-multi-pass.test.ts` still passes.
- Keep coverage for terminal broadcast after unregister.
- Keep coverage for `saveScreencast=false` not creating `frames/`.
- Add a route-level assertion that HTTP solo and HTTP multi-pass both call the
  same core wrapper path, preferably by dependency injection rather than module
  mocking.

Regression checks:

- `bun test test/runs/orchestrator.test.ts`
- `bun test test/cli/run-one.test.ts`
- `bun test test/api/run.test.ts`
- `bun test test/api/run-multi-pass.test.ts`
- Full `bun test`

## Acceptance criteria

- `src/runs/orchestrator.ts` exists and owns the single-run core lifecycle.
- `src/cli/run-one.ts` is a thin shim around the shared core.
- `src/api/routes/run.ts` no longer contains duplicated snapshot/logger/
  adapter/context/agent/result-writing assembly.
- HTTP multi-pass executor body is ≤25 lines and contains no inline
  snapshot, logger, adapter, context-tree, or `result.json` read-back
  logic.
- HTTP request validation, config merging, allow-list checks, client
  construction, detached `202` response, registry pre-registration, and
  run-set broadcasting remain in the API layer.
- WebSocket progress/event fanout and screencast streaming remain HTTP wrapper
  concerns.
- Both CLI and HTTP runs continue to write `run.jsonl`. HTTP runs now also
  write `run_error` events on thrown errors (intentional — see "Intentional
  behavior changes").
- Browser sidecar logs, including `log.jsonl`, are neither removed nor treated
  as CLI-only acceptance criteria.
- Existing run-set behavior remains unchanged.
- Existing targeted tests pass, followed by full `bun test`.

## Resolved design questions

1. **Adapter construction**: the core constructs and starts the adapter.
   Two callers building adapters two different ways is exactly what we are
   trying to eliminate.
2. **HTTP wrapper naming**: `executeRun` is renamed to `executeHttpRun`.
   The current name is the single biggest cause of confusion in the route
   file.
3. **Client injection**: the core takes an already-built `client:
   LLMClient`, not a `clientFactory`. HTTP must build the client on the
   request thread to surface model/allow-list errors as 400s; CLI builds
   it in the `runOne` shim. Tests inject either a real or stub client
   directly.

## Migration ordering

Build the core and cut both surfaces over in a single session. Sequence:

1. Land `src/runs/orchestrator.ts` with full lifecycle and tests passing.
2. Cut `src/cli/run-one.ts` over to be a shim around the core; verify
   `bun test test/cli/run-one.test.ts` passes.
3. Rename HTTP `executeRun` to `executeHttpRun`; cut both solo and
   multi-pass route paths over to the core via the wrapper; verify
   `bun test test/api/run.test.ts` and `test/api/run-multi-pass.test.ts`.
4. Run full `bun test`.

No two-implementations window — the same session that introduces the core
removes both legacy assemblies.

## Open questions

- Cancellation mid-attempt is out of scope. `runRunSet`'s `cancelToken`
  still gates between attempts. If we later want to cancel a running
  `runAgent`, the cancellation primitive will need to thread through the
  core; this spec does not anticipate that surface.

## Self-review

- Placeholder scan: no placeholders, TODOs, or deferred implementation gaps.
- Scope check: focused on single-run orchestration extraction. RunSet stays as
  the existing group orchestrator.
- Consistency check: `run.jsonl` is the core transcript throughout; browser
  sidecars are described consistently as WebAdapter observer artifacts.
- Ambiguity check: HTTP-specific behavior remains outside the shared core, with
  an explicit wrapper boundary.
