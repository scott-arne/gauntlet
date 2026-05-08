# Upstream sync: `superpowers-chrome`

Gauntlet's web adapter is built on a fork of the CDP library from
[`obra/superpowers-chrome`](https://github.com/obra/superpowers-chrome). We
intend to pull new features and bugfixes from upstream periodically. We have
also made non-trivial local changes, so these syncs are always a hand-port,
not a clean merge. This doc is the protocol.

## Files in scope

The `src/adapters/web/lib/` directory is a forked copy of upstream's
modular layout:

- `src/adapters/web/lib/chrome-ws-lib.js` ←
  `skills/browsing/chrome-ws-lib.js` (the orchestrator)
- `src/adapters/web/lib/host-override.js` ←
  `skills/browsing/host-override.js`
- `src/adapters/web/lib/<module>.js` ←
  `skills/browsing/lib/<module>.js`
- `src/adapters/web/lib/page-scripts/` ←
  `skills/browsing/lib/page-scripts/`

The browser-WS bridge files — `browser-session.js`, `browser-bridge.js`,
`page-session.js`, `cdp-router.js` — used to be Gauntlet-only (added in
PRI-1535) but as of the 2026-05-08 sync are now upstream files: the
flatten-mode migration was contributed back to
`obra/superpowers-chrome` and merged. Treat them like any other
synced module going forward.

Everything else under `src/adapters/web/` (adapter.ts, passkey.ts, etc.)
is Gauntlet-native and not synced from upstream.

## Sync state

| Field | Value |
|---|---|
| Upstream repo | `https://github.com/obra/superpowers-chrome` |
| Fork point | `70b2c6c` (v1.8.0) — 2026-02-25 |
| Last synced upstream HEAD | `60b44e2` (`mhat/flatten-mode-bridge`) — 2026-05-08; flatten-mode + bridge primitives upstreamed (PRI-1535) |

> Bump "last synced upstream HEAD" each time a sync cycle completes.

## Intentional Gauntlet divergences

Grep `chrome-ws-lib.js` for `GAUNTLET DIVERGENCE` to find these in-line.

1. **`WebSocketClient` class** uses the standard WebSocket API (works in
   Node and Bun) rather than upstream's `http.request` + hand-rolled frame
   parser. Required for Bun. When syncing, preserve this class body verbatim
   — upstream features above it call `sendCdpCommand()` and friends, which
   don't touch raw WS internals.

2. **`host-override.js`** exports mutable getters (`getHost`, `getPort`,
   `setDefaults`) so WebAdapter can point the library at a remote Chrome
   without mutating `process.env`. Upstream's constant names
   (`CHROME_DEBUG_HOST`, `CHROME_DEBUG_PORT`, `CHROME_DEBUG_BASE`,
   `WS_OVERRIDE_ENABLED`) are re-exported as module-load snapshots for
   compat, so unmodified upstream code that destructures them keeps
   working. As of upstream `51d0d68` (post-PR-#33) upstream itself
   removed those legacy exports; Gauntlet preserves them deliberately —
   that removal is the one upstream commit explicitly NOT ported by
   the 2026-05-06 sync.

3. **`pickFreePort`** replaces upstream's `findAvailablePort` range-scan
   (9222..12111). The scan raced with co-tenants on 9222. See the
   divergence marker inside `startChrome()` for the port-decision block.
   Upstream's `findAvailablePort` and `isPortFree` are intentionally
   absent.

4. **`parseContains`** plus `:contains('text')` support in
   `getElementSelector` / `getElementSelectorAll`. Gauntlet-only —
   jQuery-style `:contains` selectors from LLM agents are translated to
   a JS walk rather than failing as CSS syntax errors.

5. **Appended Gauntlet-only functions** (between the
   `GAUNTLET DIVERGENCE START: Gauntlet-only additions` marker and its
   matching END):
   - `clearBrowserData(tab)` — best-effort CDP state reset for
     remote-Chrome runs (spec §5.1 profile isolation).
   - `webAuthnOpenSession(tab)` — pinned CDP session for the passkey
     tool. The WebAuthn CDP domain is per-socket, so we bypass the pool.
   - `openObserverSession(tab, onEvent)` — streams console, exception,
     log, and network-ws events to EvidenceLogger.
   - `onCdpEvent(tabIndex, handler)` / `offCdpEvent(tabIndex)` — raw CDP
     event subscription used by screencast streaming.

6. **`screenshot()` accepts an optional 5th parameter `opts = {}`** (PRI-1517).
   `opts.timeoutMs` threads through to the `Page.captureScreenshot`
   `sendCdpCommand` call's timeout argument. When `undefined`, the
   underlying `sendCdpCommand` 30s default applies — so all upstream
   callers stay green. Marked with a `// PRI-1517` comment above the
   function. Used by Gauntlet's adapter `takeReturnScreenshot` to cap
   bundled-screenshot wall-time at 5s instead of 30s.

> **Historical: former Divergence #6 (`createSession()` / `createOverride()`
> factory wrap, PRI-1512).** Upstreamed as
> [PR #33](https://github.com/obra/superpowers-chrome/pull/33) and merged
> 2026-05-05; as of `a9e2d0c` it's the upstream baseline. The marker
> comments in `chrome-ws-lib.js` and `host-override.js` are kept (with
> reworded rationale) so future syncers still see the
> "paste upstream changes inside this closure" recipe note — the closure
> body is intentionally column-0 unindented for diff readability. Note
> upstream's `51d0d68` removed the legacy `CHROME_DEBUG_HOST` /
> `CHROME_DEBUG_PORT` / `CHROME_DEBUG_BASE` / `WS_OVERRIDE_ENABLED` /
> top-level `rewriteWsUrl` exports; Gauntlet preserves them as part of
> Divergence #2 above and did NOT port that removal.

## Sync recipe

1. **Clone upstream fresh:**
   ```sh
   cd /tmp && rm -rf superpowers-chrome
   git clone https://github.com/obra/superpowers-chrome.git
   ```

2. **List commits since our last sync** — replace `<LAST>` with the SHA
   recorded in the Sync state table:
   ```sh
   cd /tmp/superpowers-chrome
   git log --oneline <LAST>..HEAD -- \
     skills/browsing/chrome-ws-lib.js \
     skills/browsing/host-override.js
   ```
   Ignore commits that only touch `mcp/`, `CHANGELOG.md`, `SKILL.md`, or
   `.claude-plugin/` — those belong to upstream's Claude Code skill
   harness and are not part of our fork.

3. **For each commit, decide the action.** Run `git show <sha> --stat`
   and `git show <sha> -- skills/browsing/`. Categorize:
   - **Bugfix touching an unchanged region** → hand-port the diff into
     our file (do not `git apply` — line numbers will mismatch
     because of the divergences).
   - **New function added below everything upstream has** → add the
     function in the same relative location in our file, *above* the
     `GAUNTLET DIVERGENCE START: Gauntlet-only additions` block. Export
     it from `module.exports` if callers need it.
   - **Touches a divergence region** → audit carefully. The
     WebSocketClient class in particular should almost never need an
     upstream change; if it does, discuss before porting.
   - **Documentation/harness/test-only** → decide whether the tests are
     portable to our `bun test` layout under `test/adapters/web/`. The
     invariant is usually worth a test even if the literal file isn't.

4. **For each feature that becomes a new Gauntlet tool**, update
   `src/adapters/web/adapter.ts` to surface it in `toolDefinitions()` and
   dispatch it in `executeTool()`.

5. **Commit per logical change.** One upstream commit → one Gauntlet
   commit is the usual mapping. Reference the upstream SHA in the
   commit body so the trail is grep-able. Example:
   ```
   chrome-ws-lib: prefer visible elements in getElementSelector

   Hand-ported from obra/superpowers-chrome 558d376.
   Fixes CDP clicks landing on hidden mobile-layout elements at (0,0).
   ```

6. **Update this file.** Bump "Last synced upstream HEAD" to the SHA you
   caught up to. Add any newly-discovered divergences to the list.

## When a sync is big enough to need help

If the upstream delta is more than ~5 commits or spans multiple feature
areas, dispatch a Guppy per logical chunk with a tight spec (upstream SHA,
target function, which divergence markers to respect). Review each chunk
before merging. Treating each upstream commit as its own task makes
regressions easier to bisect.
