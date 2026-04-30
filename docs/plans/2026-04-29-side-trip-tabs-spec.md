# Side-Trip Tabs — Spec

PRI-1439 · 2026-04-29 · Stephen Maturin

## Problem

The Gauntlet web agent operates a single browser tab. When a signin flow needs a side trip — fetching an OTP from email, retrieving a credential from a password manager, completing a 2FA portal handoff — the agent has no choice but to navigate the existing tab away from the partially-filled signin form. On return, form values are lost, in-flight cookies the origin set during the flow may be invalidated, and the JS state is gone. The agent then loops trying to recover, sometimes for dozens of turns.

This spec adds the smallest tool surface that fixes the case: an explicit "open a side tab, work in it, close it to return" capability.

## Non-goals

- General-purpose multi-tab control. The agent should not learn to juggle five tabs in parallel.
- Per-tool `tab_index` parameters. Every existing tool's schema stays unchanged.
- Tab switching to an arbitrary previously-opened tab. Only push/pop.
- Multi-target screencast. v1 streams the original tab only.

## Tool surface (additions)

Two new tools, exposed alongside the existing fourteen.

### `new_tab(url, return_screenshot?)`

Opens a new browser tab navigated to `url` and makes it the active tab. Subsequent tool calls (`click`, `type`, `extract`, etc.) operate on the new tab until it is closed.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | Absolute URL to open in the new tab. |
| `return_screenshot` | boolean | no | Capture a screenshot after the tab loads. |

**Result text on success:** `opened tab (depth N)` where N is the resulting stack depth (1 = original tab, 2 = first side trip, etc.).

**Errors:**
- `Error: too many side-trip tabs (max 5)` — depth cap reached.
- `Error: <reason>` — underlying chrome-ws-lib error (e.g., Chrome unreachable).

### `close_tab(return_screenshot?)`

Closes the active tab and returns focus to the previous tab. Cannot close the original tab — the agent must use `navigate` for primary navigation.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `return_screenshot` | boolean | no | Capture a screenshot of the now-active tab after closing. |

**Result text on success:** `closed tab (depth N)` where N is the new stack depth after popping.

**Errors:**
- `Error: cannot close the original tab — use navigate to change the page` — depth was 1.

### Existing tools — no schema change

All other tools (`click`, `type`, `press`, `hover`, `double_click`, `right_click`, `drag`, `mouse_move`, `scroll`, `file_upload`, `screenshot`, `navigate`, `extract`, `eval`, `wait_for`) keep their current parameter schema. They transparently target the active tab.

`install_passkey` and `install_cookies` continue to operate on the original tab regardless of focus, because they manipulate browser-wide / origin-scoped state, not tab state. (Cookies are origin-scoped; the WebAuthn virtual authenticator is browser-wide.)

## State model — focus stack

The `WebAdapter` owns an ordered list of tab WebSocket URLs:

```
tabStack: string[] = [<original tab ws url>]
                       ↑                     ↑
                    bottom (original)      top (active)
```

- The bottom is the original tab opened during `start()`. It is never popped.
- `new_tab` pushes the freshly-created tab's `webSocketDebuggerUrl`.
- `close_tab` pops the top URL and asks chrome-ws-lib to close it.
- `activeTab()` returns the top URL; every adapter dispatch hands that URL (not a numeric index) to the underlying chrome-ws-lib call.

### Why WebSocket URL, not numeric index

`chrome-ws-lib`'s tab-keyed APIs accept either `number` (resolved via `GET /json` per call) or `string` (a WebSocket URL passed straight through). Numeric indices reorder when tabs close — closing tab 1 of `[0, 1, 2]` shifts tab 2 to index 1. WebSocket URLs are stable for the life of a tab. The adapter has historically passed `0` only because there was always one tab; with side trips, stable identity matters.

### Initial population

`WebAdapter.start(url)` already navigates the (auto-created) tab 0 to the start URL. After that line, the adapter resolves `getTabs()[0].webSocketDebuggerUrl` once and seeds the stack with it as the original tab. All subsequent adapter dispatches use that WS URL instead of the constant `0`.

## Limits & cleanup

- **Stack depth cap: 5.** `new_tab` returns an error result when depth would exceed 5. The cap is a guardrail — typical use is one or two levels (signin → email; signin → password manager → 2FA portal). Configurable via constant; not exposed.
- **Force-close on `close()`.** When the adapter is torn down, any tabs still on the stack above the original are closed best-effort. The original is closed by `killChrome()` (local) or left alone (remote).
- **Tabs the user/agent didn't open via `new_tab`.** If a click triggers `target="_blank"` or `window.open`, a new tab appears in Chrome but is *not* on the focus stack — the agent's view of the world is unchanged. v1 ignores those tabs. (Future: detect via `targetCreated` and either auto-close or surface to the agent — see follow-ups.)

## System-prompt update

A short paragraph is appended to the web-adapter system prompt:

> If a signin flow asks you to fetch a code from email, retrieve a password from a password manager, or visit another site for a verification step, use `new_tab(url)` to open that site in a side tab. Work there as you would normally. When done, call `close_tab` to return to the original page — its form values, cookies, and scroll position will be intact. Do not use `navigate` for side trips: it will reset the original page state.

This lives in `src/agent/prompts.ts` next to the existing tool-usage hints. Tests assert the paragraph mentions both new tools and frames them as the OTP/side-trip case.

## Evidence & transcript

The `EvidenceLogger` already records every tool call with its name and args. The browser-event observer is opened on the original tab and stays there (it streams console/log/exception events from one target only).

For multi-tab visibility:
- Each successful `new_tab` and `close_tab` is logged as a normal tool call. The result text records the new stack depth.
- A new evidence event `tab_focus_changed` is logged with `{ depth, ws_url, url }` whenever the stack mutates, so reviewers reading `run.jsonl` can correlate later actions (`click`, `extract`) to the tab they hit.
- Non-tab tool calls do not stamp tab info into their result text; the focus-changed events provide the timeline.

## Screencast (v1 scope)

The screencast streamer (`src/streaming/screencast.ts`) pins to a tab index at construction time and currently always uses `0`. For v1 it stays pinned to the original tab. Side-trip tabs are *not* live-streamed.

Justification: the agent's interaction with a side-trip tab is short (10–60 seconds typical), and the frames would require multi-target streaming infra that's beyond this change. The transcript still records every action with screenshots when the agent passes `return_screenshot: true`.

Follow-up (out of scope): make screencast follow the focus stack — stop streaming on push, start streaming on pop, or merge multi-target streams. Tracked separately if and when it becomes a felt limitation.

## Concurrency

Each `WebAdapter` already owns its own `ChromeSession` (per PRI-1436). The focus stack is per-adapter, so concurrent stories under `gauntlet serve` cannot interfere with each other's tabs.

## Edge cases

| Case | Behavior |
| --- | --- |
| `close_tab` at depth 1 | Refused; result text instructs agent to use `navigate`. |
| `new_tab` at depth 5 | Refused; result text mentions the cap. |
| `new_tab` with malformed URL | chrome-ws-lib's `newTab` accepts any string and Chrome resolves it; if Chrome rejects, the error surfaces as `Error: <reason>` and the stack is *not* mutated (we only push on success). |
| Side-trip tab navigates itself (e.g., OAuth redirect) | Fine — adapter dispatches use the WS URL; navigation within a tab does not change its WS URL. |
| Side-trip tab is closed by the page (e.g., `window.close()`) | Next adapter dispatch to that WS URL will fail. v1 surfaces the chrome-ws-lib error to the agent; agent can call `close_tab` to pop. (Auto-pop on `targetDestroyed` is a follow-up.) |
| Adapter close while side-trip tab is open | Best-effort `closeTab(wsUrl)` for each stack entry above the original, then `killChrome()`. |
| Original tab is closed externally | Out of scope; the run was already broken before tabs were a concept. |

## Test plan

Unit tests under `test/adapters/web/`:

1. **Tool definitions exist and have correct schemas.** `new_tab` requires `url`; `close_tab` accepts only optional `return_screenshot`.
2. **Stack starts at depth 1 with the original tab's WS URL** after `start()`. Asserted via a stub `chromeSession` that records the URLs passed to `navigate`/`click`/etc.
3. **`new_tab` pushes** — after `new_tab`, a subsequent `click` is dispatched with the new tab's WS URL.
4. **`close_tab` pops** — after `new_tab` then `close_tab`, a `click` dispatches against the original WS URL again.
5. **`close_tab` at depth 1 refuses** with the documented error message; stack unchanged.
6. **`new_tab` at depth 5 refuses** with the documented error message; stack unchanged; no chrome-ws-lib call made.
7. **`new_tab` failure does not push** — when stub `newTab()` throws, the next dispatch still hits the original tab.
8. **System-prompt mention.** `buildSystemPrompt` for a web adapter includes mentions of both `new_tab` and `close_tab` and the words "side trip" or equivalent.
9. **Evidence event on focus change.** A spy logger records `tab_focus_changed` events with the right depth on push and pop.
10. **`close()` force-closes side-trip tabs.** When the adapter is closed at depth 3, the stub records `closeTab` calls for the two side-trip URLs.

Existing web-adapter tests must pass unchanged — the public schema of the existing 14 tools is unchanged.

## Files touched

- `src/adapters/web/adapter.ts` — focus stack; `activeTab()`; replace hardcoded `0` in dispatches; new `new_tab`/`close_tab` tool definitions and dispatch cases; force-close on teardown.
- `src/agent/prompts.ts` — append side-trip paragraph to web-adapter prompt.
- `test/adapters/web/adapter.test.ts` — new tests per the test plan.
- `test/agent/prompts.test.ts` — assert side-trip paragraph for web adapter.

## Risks

- **Agent over-uses tabs.** If the system prompt is too encouraging, the agent may open side tabs for navigation that doesn't need them, increasing turns and complexity. Mitigation: prompt language frames it specifically as "fetch a code / credential / verification" use case, not general navigation. Worth watching the first dozen runs after merge.
- **Stale WS URL after a navigation.** A WS URL can be invalidated if the tab cross-process-navigates and Chrome reuses the URL for a new target. chrome-ws-lib's `resolveWsUrl` will pass the URL through; if the tab is gone, the WS connect fails and the agent gets `Error: <reason>`. The agent can recover via `close_tab`. Acceptable for v1.
- **No `close_tab` in agent's vocabulary leads to leaked tabs.** Mitigated by force-close on adapter teardown.
