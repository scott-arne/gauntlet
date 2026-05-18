import { rm } from "fs/promises";
import type { EvidenceLogger, BrowserEventCategory } from "../../evidence/logger";
import type { Viewport } from "../../config";
import type { ChromeSession } from "./adapter";
import type { PasskeyTool } from "./passkey";

/**
 * Lifecycle helpers for WebAdapter — start() and close().
 *
 * These are the most stateful methods on the adapter (Chrome attach
 * + launch, BrowserContext create + dispose, observer-session
 * lifecycle, side-trip tab teardown, per-run profile-dir cleanup).
 * Pulled into a sibling file so the adapter facade can stay focused
 * on dispatch, and so the lifecycle code can be exercised
 * independently (today most of start/close is exercised only through
 * e2e tests).
 *
 * The helpers take a state struct that exposes the mutable fields
 * each routine reads or writes. The adapter holds the canonical
 * state on `this` and threads a view through to these functions.
 */

interface ObserverSession {
  close(): void;
  isClosed?(): boolean;
}

interface BrowserContext {
  browserContextId: string;
  createPage(url?: string): Promise<{
    id: string;
    targetId: string;
    webSocketDebuggerUrl: string;
    type: string;
    url: string;
    browserContextId: string;
  }>;
  dispose(): Promise<void>;
}

/**
 * Mutable view of WebAdapter state that start/close need to touch.
 * Functions in this file mutate the struct in place — the adapter
 * passes `this` (cast through this interface) and reads back the
 * post-call values.
 */
export interface WebLifecycleState {
  readonly remote: boolean;
  readonly chrome: ChromeSession;
  readonly chromeProfileName: string | null;
  readonly viewport: Viewport | null;
  readonly logger: EvidenceLogger | null;
  readonly passkeyTool: PasskeyTool | null;
  readonly tabStack: Array<{ wsUrl: string; url: string }>;
  context: BrowserContext | null;
  observerSession: ObserverSession | null;
}

export async function startWebAdapter(
  state: WebLifecycleState,
  url: string,
): Promise<void> {
  if (!state.remote) {
    // Pass the per-run profile name (spec §5.1) so each run gets its
    // own --user-data-dir. Falls back to chrome-ws-lib's default when
    // the runner did not provide one (kept for test backwards-compat).
    await state.chrome.startChrome(true, state.chromeProfileName ?? null); // headless
  }

  // PRI-1535: one BrowserContext per WebAdapter — atomic isolation primitive
  // replacing the per-launch --user-data-dir for cleanup. createBrowserContext
  // lazy-opens the browser-WS under the hood. createPage navigates the new
  // page to the target URL, so no separate navigate(0, url) is needed.
  const ctx = await state.chrome.createBrowserContext();
  state.context = ctx;
  const page = await ctx.createPage(url);

  // Seed the focus stack with the page's WS URL (PRI-1439).
  state.tabStack.push({
    wsUrl: page.webSocketDebuggerUrl,
    url: page.url ?? url,
  });

  // Pin the viewport against this specific page's WS URL — under
  // BrowserContext-per-adapter, getTabs()[0] is no longer guaranteed to
  // be our page. Best-effort: a failed viewport override does not fail
  // the run, since --window-size already gives a reasonable default.
  if (state.viewport) {
    try {
      await state.chrome.setViewport(page.webSocketDebuggerUrl, {
        width: state.viewport.width,
        height: state.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    } catch (err) {
      state.logger?.logEvent("set_viewport_failed", {
        reason: err instanceof Error ? err.message : String(err),
        requested: state.viewport,
      });
    }
  }

  // PRI-1535: the previous remote-only `clearBrowserData(0)` call is gone —
  // a fresh BrowserContext starts clean by construction.

  // Open the observer session against the page's WS URL (not numeric 0).
  // Runs *after* the page is created so the initial load and LiveSocket
  // handshake are captured as the first events we see.
  if (state.logger) {
    const logger = state.logger;
    try {
      state.observerSession = await state.chrome.openObserverSession(
        page.webSocketDebuggerUrl,
        (category: BrowserEventCategory, payload: Record<string, unknown>) => {
          try {
            logger.logBrowserEvent(category, payload);
          } catch {
            // evidence writes are best-effort; never let them break a run
          }
        },
      );
    } catch (err) {
      // Observer is supplementary. If it fails to start, log and continue.
      const reason = err instanceof Error ? err.message : String(err);
      logger.logEvent("observer_session_failed", { reason });
    }
  }
}

export async function closeWebAdapter(state: WebLifecycleState): Promise<void> {
  // Close the observer first so it stops trying to drain events from
  // a dying target.
  if (state.observerSession) {
    try {
      state.observerSession.close();
    } catch {
      // best-effort
    }
    state.observerSession = null;
  }
  // PRI-1439: pop and close any side-trip tabs the agent left open
  // (anything pushed above the original). The original tab is left
  // alone — it'll go away when killChrome() runs (local) or be reset
  // by the next run via clearBrowserData (remote). Each force-close
  // emits a `tab_focus_changed` pop so the run.jsonl timeline shows
  // every push paired with a pop.
  while (state.tabStack.length > 1) {
    const popped = state.tabStack.pop()!;
    state.logger?.logEvent("tab_focus_changed", {
      action: "pop",
      depth: state.tabStack.length,
      ws_url: popped.wsUrl,
      url: popped.url,
      reason: "adapter_close",
    });
    try {
      await state.chrome.closeTab(popped.wsUrl);
    } catch (err) {
      state.logger?.logEvent("tab_force_close_failed", {
        ws_url: popped.wsUrl,
        url: popped.url,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Drop the original tab from the stack so a reused adapter would
  // start clean. Reuse isn't a current code path, but the inconsistent
  // post-close state is an easy footgun.
  state.tabStack.length = 0;

  // PRI-1535: dispose the BrowserContext atomically. Runs AFTER the
  // side-trip pop loop (which relies on per-page WS being usable for
  // closeTab) and BEFORE killChrome / passkey teardown. Chrome tears
  // down cookies/storage/IDB/SW for the context in one call, replacing
  // the inline clearBrowserData sweep that used to live in start().
  if (state.context) {
    try {
      await state.context.dispose();
    } catch (err) {
      state.logger?.logEvent("browser_context_dispose_failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    state.context = null;
  }
  // Tear the virtual authenticator down before killing Chrome so that
  // remote Chrome sessions (where we didn't start the process) don't
  // leak state across runs. For locally-spawned Chrome, killChrome
  // makes this a best-effort no-op — errors are swallowed inside.
  if (state.passkeyTool) {
    await state.passkeyTool.teardown();
  }
  if (!state.remote) {
    await state.chrome.killChrome();
    // Recursively delete the per-run Chrome profile directory (spec
    // §5.1). Best-effort: failures are logged as an action-log entry
    // but never thrown — a leftover stale dir is preferable to
    // failing the close path. Skipped when no profile name was
    // provided (e.g., legacy/test usage without a runner).
    if (state.chromeProfileName) {
      const dir = state.chrome.getChromeProfileDir(state.chromeProfileName);
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        state.logger?.logEvent("chrome_profile_cleanup_failed", {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
