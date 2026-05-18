# Web-adapter split proposal (PRI-1628 Phase 5)

Author: Quill@ca344945
Status: **Awaiting Susan review (hard gate per the cleanup-sweep plan)**

## Context

`src/adapters/web/adapter.ts` is 1254 LOC. The cleanup-sweep plan's
acceptance criterion is ≤500 LOC in `adapter.ts`. Per the plan, we
extend the pattern already established by `passkey.ts` and `cookies.ts`
(sibling helper files): move per-capability code out of the adapter
into smaller sibling files.

**Naming wrinkle.** The plan literally said "under
`src/adapters/web/lib/`," but that directory already holds the vendored
`chrome-ws-lib` (a JS dependency). I propose placing the new
extractions as **siblings to `adapter.ts`** (alongside `passkey.ts`,
`cookies.ts`) rather than nesting them in `lib/`. The
`web/lib/chrome-ws-lib` namespace is a vendored library, not the right
home for first-party extractions. If Susan prefers a `web/lib/` for
first-party code, I can rename to `web/lib/`-something to keep the
vendored copy distinct (e.g. `web/lib/chrome-ws-lib` stays where it is,
new files go under `web/lib/<name>.ts` next to it). Flag your
preference in review.

## Current structure of `adapter.ts`

| Section | Lines | LOC | Notes |
|---|---|---|---|
| Imports + types + driver factories + composeResult | 1–173 | 173 | small helpers that hang off the file |
| `WebAdapter` class fields + constructor | 175–269 | 95 | construction, dependency wiring |
| `getChromeSession`, `activeTab`, `waitForPopupAfter` | 270–332 | 63 | small accessors + private helper |
| `start()` | 334–402 | 69 | Chrome attach/launch, initial nav, viewport, observer hookup, BrowserContext create |
| `describeTarget`, `defaultViewport` | 403–412 | 10 | trivial |
| `close()` | 414–496 | 83 | tab pop, BrowserContext dispose, passkey teardown, Chrome kill, profile dir cleanup |
| `isMutatingTool` | 498–500 | 3 | one line, defers to the module-level Set |
| `toolDefinitions()` | 502–890 | **389** | 16-tool schema dump |
| `executeTool()` + `takeReturnScreenshot` closure + switch dispatch | 891–1254 | **364** | the actual tool implementations |

Two giant sections account for 753 LOC: `toolDefinitions` (389) and the
`executeTool` switch (364). Splitting both is the lever.

## Proposed split

Files all live alongside `adapter.ts` under `src/adapters/web/`. Each is
a sibling of `passkey.ts` and `cookies.ts`.

### 1. `tool-defs.ts` — tool-definition surface

**Export:** `webToolDefinitions(opts?: { includePasskey: boolean; includeCookies: boolean; includeSharedTools: SharedTools }): ToolDefinition[]`

Returns the static array of `ToolDefinition` objects, filtered by which
optional tools are wired (passkey / cookies / shared). Schemas are
strings + plain objects — no runtime state, pure function.

The two install_* tools and the shared-tools array (read, screenshot,
extract, etc.) are wired in by the caller because they depend on the
adapter's construction context.

**LOC est:** ~400 (mostly the verbatim schema definitions; description
strings are load-bearing model prompts and we don't touch them).
**Public surface:** one function + the existing `ToolDefinition` type.

### 2. `lifecycle.ts` — start / close / observer-session wiring

**Exports:**
- `startWebAdapter(state: WebAdapterState, url: string): Promise<void>`
- `closeWebAdapter(state: WebAdapterState): Promise<void>`

Where `WebAdapterState` is a struct that captures all the mutable
fields `start`/`close` read or write: `chrome`, `remote`,
`chromeProfileName`, `viewport`, `tabStack`, `context`, `observerSession`,
`passkeyTool`, `logger`. The functions mutate the struct.

This is the part that uses the most chrome-ws-lib calls. Pulling it out
makes the lifecycle independently testable (today most of `start`/`close`
is exercised only through e2e tests).

**LOC est:** ~180.
**Public surface:** two functions + the WebAdapterState type (used
internally; not exported beyond the web/ directory).

### 3. `tools/screenshot.ts`, `tools/click.ts`, ... — per-tool implementations

The switch cases in `executeTool` are mostly one-screenful each (10–40
lines), but together they total ~340 LOC. The natural grouping is by
tool family:

- `tools/visual.ts` — `screenshot`, `extract`, `wait_for` (read-only DOM + pixels)
- `tools/pointer.ts` — `click`, `double_click`, `right_click`, `hover`, `drag`, `mouse_move`, `scroll`
- `tools/keyboard.ts` — `type`, `press`
- `tools/page-actions.ts` — `navigate`, `eval`, `file_upload`
- `tools/tabs.ts` — `new_tab`, `close_tab` (the side-trip mechanics)

Each file exports one function per tool, e.g.

```ts
export async function executeClick(
  state: WebAdapterState,
  args: ClickArgs,
  takeReturnScreenshot: ReturnScreenshotFn,
  logger: EvidenceLogger,
): Promise<ToolResult> { ... }
```

The `takeReturnScreenshot` closure stays in `executeTool` (it captures
the `tab` it was invoked against) and gets threaded as a function arg.

**LOC est per file:** 60–120. Total ~400.
**Public surface:** one execute function per tool, exported by name.

### 4. `adapter.ts` (the facade) — what stays

After the split, `adapter.ts` retains:

- Type re-exports (`ChromeSession`, `WebAdapterOptions`, `ScreenshotResult`, `composeResult`)
- Driver factories (`makeWebAuthnDriver`, `makeCookiesDriver`)
- The `WebAdapter` class with:
  - Constructor + private state
  - `getChromeSession`, `describeTarget`, `defaultViewport`,
    `isMutatingTool`, `activeTab` (small accessors)
  - `start()` → `startWebAdapter(this.state(), url)`
  - `close()` → `closeWebAdapter(this.state())`
  - `toolDefinitions()` → `webToolDefinitions(...)`
  - `executeTool()` — the schema-validation prelude, the shared-tools
    dispatch, the install_* dispatch, the `takeReturnScreenshot`
    closure, and the switch dispatching to `tools/*.ts` exports

**LOC est for the facade:** ~320 (constructor 50 + small methods 70 +
executeTool prelude+switch 200).

## Estimated post-split totals

| File | LOC | Role |
|---|---|---|
| `adapter.ts` | ~320 | facade, class shell, dispatch |
| `tool-defs.ts` | ~400 | schema array |
| `lifecycle.ts` | ~180 | start + close |
| `tools/visual.ts` | ~80 | screenshot / extract / wait_for |
| `tools/pointer.ts` | ~120 | mouse-driven tools |
| `tools/keyboard.ts` | ~30 | type / press |
| `tools/page-actions.ts` | ~80 | navigate / eval / file_upload |
| `tools/tabs.ts` | ~90 | new_tab / close_tab |
| `passkey.ts` | unchanged | already extracted |
| `cookies.ts` | unchanged | already extracted |
| **total under `src/adapters/web/`** | ~1300 | net flat — split is about boundaries, not LOC reduction |

`adapter.ts` clears the 500-LOC acceptance threshold with margin (~320
vs. ≤500).

## Risk and order of operations

The risk profile is mostly mechanical-error: moving 350 lines of switch
cases into separate files is the kind of work where a single wrong
import wires the wrong `chrome` into the wrong tool. Mitigations:

1. **Extract in dependency order.** `tool-defs.ts` first (zero state
   dependencies; pure function). Then `tools/*.ts` (each depends on
   chrome-ws-lib + state struct, not on each other). Then `lifecycle.ts`
   last (the most stateful).

2. **One capability per commit.** Per the plan, run `bun run check`
   after every move. Existing test coverage under
   `test/adapters/web/adapter.test.ts` is substantial — ~150 tests
   exercise the tool implementations directly.

3. **`takeReturnScreenshot` stays in `executeTool`.** It captures `tab`
   from the dispatch site and is a closure over `this.chrome` + `logger`.
   Pulling it out adds two more parameters to every tool function's
   signature for no readability win.

4. **Don't refactor tool logic during the move.** Cut, paste, fix
   imports, run tests. Refactoring (parameter normalization, error
   formatting) is a follow-on.

## Open questions for Susan

1. **Directory placement** — `src/adapters/web/<name>.ts` (proposed,
   sibling to passkey/cookies) or `src/adapters/web/lib/<name>.ts`
   (matches plan text, but lib/ contains the vendored chrome-ws-lib)?
2. **Sub-directory for tools** — `web/tools/*.ts` or flat sibling
   `web/tool-<name>.ts`? Five flat-named files vs one tools/ folder.
3. **Acceptance threshold check** — the plan's ≤500 LOC for `adapter.ts`
   is met (~320 estimated). The total LOC across `web/` does not shrink
   meaningfully; the split is for navigability and testability, not LOC.

Once the directory/naming questions land, the actual moves are ~5
mechanical commits, each verified by `bun run check`. Without them
landing first, I'd be guessing at one or the other.
