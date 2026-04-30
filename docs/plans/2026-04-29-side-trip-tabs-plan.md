# Side-Trip Tabs — Implementation Plan

PRI-1439 · 2026-04-29 · Stephen Maturin · TDD

Implements [docs/plans/2026-04-29-side-trip-tabs-spec.md](./2026-04-29-side-trip-tabs-spec.md). Each task lands as a single commit. Red→green within each task: write the failing test first, then the production code, then run `bun test` and `bun run typecheck`.

## Test stub — `chromeSession`

`WebAdapter` already accepts `options.chromeSession` for DI (per PRI-1436). All tests build a stub like:

```ts
function makeStub() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const make = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    if (method === "newTab") return Promise.resolve({ webSocketDebuggerUrl: `ws://stub/${calls.length}` });
    if (method === "getTabs") return Promise.resolve([{ webSocketDebuggerUrl: "ws://stub/0" }]);
    return Promise.resolve();
  };
  return {
    calls,
    session: new Proxy({}, { get: (_, prop: string) => make(prop) }),
  };
}
```

Tests assert on `calls` to verify which WS URL each dispatch hits.

## Task 1 — Tool definitions for `new_tab` and `close_tab`

**Test (red):** `test/adapters/web/adapter.test.ts` — assert `toolDefinitions()` includes `new_tab` (requires `url`, optional `return_screenshot`) and `close_tab` (only optional `return_screenshot`).

**Code (green):** add the two `ToolDefinition` entries in `WebAdapter.toolDefinitions()`. No dispatch yet — executing them throws `Unknown tool` for now.

**Verification:** `bun test test/adapters/web/adapter.test.ts`.

## Task 2 — Focus stack: seed with original tab in `start()`

**Test (red):** with a stub session, call `adapter.start(url)`, then `adapter.executeTool("click", { selector: "#x" })`. Assert the stub's `click` was called with the WS URL returned by `getTabs()[0]`, not the literal `0`.

**Code (green):**
- Add `private tabStack: string[] = []`.
- After the existing `await this.chrome.navigate(0, url)` in `start()`, call `getTabs()` and push `tabs[0].webSocketDebuggerUrl` onto the stack.
- Add `private activeTab(): string | number` returning the top of the stack, falling back to `0` for safety if the stack is empty (tests that never called `start()` still work).
- Replace every hardcoded `this.chrome.X(0, ...)` with `this.chrome.X(this.activeTab(), ...)`. ~14 sites in `adapter.ts`. Leave `setViewport(0, ...)`, `clearBrowserData(0)`, `openObserverSession(0, ...)`, `screenshot(0, ...)` inside `start()` alone (these run before the stack is seeded; they explicitly target the original tab during setup). The observer remains pinned to the original tab — that is the intended v1 behavior per spec.
- Leave `PASSKEY_TAB`/`COOKIES_TAB` constants alone — those tools target browser-wide / origin-scoped state per spec.

**Verification:** existing dispatch tests still pass (they use stub session and never relied on the `0` literal); new test passes.

## Task 3 — `new_tab` dispatch pushes to stack

**Test (red):** call `adapter.start(url)` then `adapter.executeTool("new_tab", { url: "https://mail.example/" })` then `adapter.executeTool("click", { selector: "#x" })`. Assert:
- Stub's `newTab` was called with the URL.
- The subsequent `click` dispatched against the WS URL `newTab` returned (`ws://stub/2` in the stub).
- Result text from `new_tab` is `opened tab (depth 2)`.

**Code (green):** add the `new_tab` case in `executeTool`. On success, push the returned `webSocketDebuggerUrl`. On error, do not push and return `Error: <reason>`.

## Task 4 — `close_tab` dispatch pops the stack

**Test (red):** start, `new_tab`, then `close_tab`, then `click`. Assert stub's `closeTab` was called with the side-trip WS URL, the post-close `click` dispatched against the original WS URL, and `close_tab`'s result text is `closed tab (depth 1)`.

**Code (green):** add the `close_tab` case. Pop the stack first, then call `chrome.closeTab(poppedUrl)`. (Pop-first means a chrome-ws-lib failure still leaves us in a sane state — the tab is already gone from the agent's mental model. Best-effort close is fine because we don't want a stuck side-trip tab to wedge the agent.)

## Task 5 — `close_tab` at depth 1 refuses

**Test (red):** start, then `close_tab` immediately. Assert result text is the documented refusal (`Error: cannot close the original tab — use navigate to change the page`), no `closeTab` call was made on the stub.

**Code (green):** depth-1 guard at the top of the `close_tab` case.

## Task 6 — `new_tab` at depth 5 refuses

**Test (red):** start, `new_tab` four times, then a fifth `new_tab`. Assert the fifth returns `Error: too many side-trip tabs (max 5)`, no fifth `newTab` call on stub, stack depth still 5.

**Code (green):** depth-cap guard at the top of the `new_tab` case. Constant `MAX_TAB_DEPTH = 5` at top of file.

## Task 7 — `new_tab` failure does not push

**Test (red):** stub's `newTab` rejects. Call `new_tab`, then `click`. Assert `click` still hit the original WS URL; result text from `new_tab` is `Error: ...`.

**Code (green):** wrap the chrome call in try/catch; only push on success.

## Task 8 — `tab_focus_changed` evidence event

**Test (red):** spy logger captures `logEvent` calls. After `start` → `new_tab` → `close_tab`, assert two `tab_focus_changed` events were logged: one with `{ depth: 2, ws_url: <new>, action: "push" }`, one with `{ depth: 1, ws_url: <original>, action: "pop" }`.

**Code (green):** in the `new_tab`/`close_tab` cases, after a successful stack mutation, call `logger.logEvent("tab_focus_changed", { depth, ws_url, action })`. Logger is already passed into `executeTool`.

## Task 9 — System prompt mentions side-trip tabs (web only)

**Test (red):** in `test/agent/prompts.test.ts` (existing file), assert `buildSystemPrompt` for a web-adapter card contains `new_tab` and `close_tab` and the phrase "side trip" (or "side tab" / "side-trip" — pick one and stick to it; we use "side tab" to match the prompt prose).

`buildSystemPrompt` does not currently know which adapter is in play; check the function signature. If it takes the adapter or tool list, condition the paragraph on web. If it doesn't, add an `adapter` parameter and thread it through `agent.ts` (one call site).

**Code (green):**
- If trivial: append a short paragraph unconditionally (the prompt is already only used for adapters that have these tools at runtime — but a CLI/TUI run would receive irrelevant tool advice). Prefer threading.
- Add a small `adapterName` param to `buildSystemPrompt`. In `agent.ts:110`, pass `adapter.name`. Append the side-trip paragraph only when `adapterName === "web"`.

## Task 10 — Force-close side-trip tabs on adapter `close()`

**Test (red):** start, `new_tab` twice (depth 3), then `adapter.close()`. Assert stub's `closeTab` was called twice (once per side-trip URL, in pop order).

**Code (green):** in `close()`, before `killChrome()` (or unconditionally for remote), iterate `tabStack` from top down to (but not including) index 0 and call `chrome.closeTab(url)` best-effort, swallowing errors. Empty the stack at the end.

## Task 11 — Typecheck + full suite green

**Verification only:** `bun run typecheck && bun test`. Fix any drift surfaced by the broader suite (e.g., a test that asserted `chrome.click` was called with `0`).

## Task 12 — Commit + merge

Per project policy (no PRs):

```
git add -A && git commit -m "feat(web): side-trip tabs (new_tab/close_tab) for OTP flows (PRI-1439)"
git checkout main && git merge --no-ff matt/pri-1439-web-agent-side-trip-tabs && git push origin main
```

Move PRI-1439 to **In Review** with a reflective comment.

## Sequencing notes

Tasks 1–7 are pure adapter mechanics with stubbed Chrome — fast feedback, no flakiness risk.
Tasks 8–10 cross into evidence and prompt territory but stay unit-level.
Task 11 is the integration safety net — running the full suite catches anything downstream of the `0`→`activeTab()` rewrite.

Estimated time: 60–90 minutes for one engineer doing inline TDD. Inline implementation preferred over subagents — the change is single-file, fast feedback matters more than parallelism.
