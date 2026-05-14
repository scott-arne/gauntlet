import { readFileSync, unlinkSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Adapter } from "../adapter";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger, BrowserEventCategory } from "../../evidence/logger";
import { DEFAULT_VIEWPORT, type ChromeEndpoint, type Viewport } from "../../config";
import type { CredentialResolverConfig } from "../../config";
import { buildReadTool, type ReadTool } from "../../context/read-tool";
import { buildFetchCredentialTool, type FetchCredentialTool } from "../../context/credential-tool";
import {
  buildInstallPasskeyTool,
  type PasskeyTool,
  type WebAuthnDriver,
} from "./passkey";
import {
  buildInstallCookiesTool,
  type CookiesDriver,
  type CookiesTool,
} from "./cookies";
import { validateToolArgs } from "../../agent/validators";

// The forked CDP library is CommonJS JS — use require for bun compatibility.
// PRI-1436: chrome-ws-lib's only top-level export is now `createSession()`.
// Each WebAdapter instance gets its own session-bag so concurrent web runs
// in `gauntlet serve` don't share globals (activePort, profile name,
// connection pool, etc.).
//
// The session is dynamically typed (the underlying lib is JS); we model
// it as a flat record of callable methods. The previous code used a bare
// `require()` whose return type was `any`, so this type is intentionally
// loose to preserve that behavior.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChromeSession = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSession } = require("./lib/chrome-ws-lib") as {
  createSession: (opts?: { host?: string; port?: number }) => ChromeSession;
};

// Passkey and cookies tools both act on tab index 0 (the original tab),
// because they manipulate browser-wide / origin-scoped state rather than
// tab state. They are unaffected by the side-trip focus stack (PRI-1439).
const PASSKEY_TAB = 0;
const COOKIES_TAB = 0;

// PRI-1439: cap on side-trip nesting depth. 1 = original tab only;
// each `new_tab` pushes; each `close_tab` pops. Typical use is 1–2 levels
// (signin → email; signin → password manager → 2FA portal). The cap is
// a guardrail against runaway tab creation, not a tuning knob.
const MAX_TAB_DEPTH = 5;

// Tools whose successful invocation changes browser/application state.
// Used by isMutatingTool() to decide which calls land in the reflection
// trace. read / screenshot / extract / wait_for / install_passkey /
// install_cookies are observational or out-of-band setup; they are
// excluded so the trace surfaces the agent's actual attempts to drive
// the page.
const WEB_MUTATING_TOOLS = new Set([
  "click", "type", "press", "hover", "double_click", "right_click",
  "drag", "mouse_move", "scroll", "file_upload", "navigate", "eval",
  "new_tab", "close_tab",
]);

// Hard cap on how long a `return_screenshot` capture is allowed to take.
// The pre-fix observed failure mode was a 30s hang when the capture was
// issued mid-navigation; this cap turns that into a fast skip-with-reason
// instead (see PRI-1517).
const RETURN_SCREENSHOT_TIMEOUT_MS = 5000;

// The default driver opens a dedicated CDP session (pinned WebSocket) for
// WebAuthn. See chrome-ws-lib's webAuthnOpenSession comment for why we
// bypass the connection pool.
function makeWebAuthnDriver(chrome: ChromeSession): WebAuthnDriver {
  return {
    async openSession(tab) {
      return await chrome.webAuthnOpenSession(tab);
    },
  };
}

// Cookies driver — thin pass-through over chrome-ws-lib's `setCookies`,
// which already aggregates per-entry results into the SetCookieResult
// shape. No pinned session: cookies live in the browser, not the CDP
// session.
function makeCookiesDriver(chrome: ChromeSession): CookiesDriver {
  return {
    async setCookies(tab, cookies) {
      return await chrome.setCookies(tab, cookies);
    },
  };
}

interface ObserverSession {
  close(): void;
  isClosed?(): boolean;
}

export interface WebAdapterOptions {
  chrome?: ChromeEndpoint;
  contextRoot?: string;
  /**
   * Optional evidence logger. When provided, the adapter opens a background
   * observer session on start() and streams browser console messages,
   * uncaught exceptions, browser log entries, and WebSocket lifecycle
   * events to the logger as per-category JSONL files in the run's evidence
   * directory. When omitted, no background logging happens.
   */
  logger?: EvidenceLogger;
  /**
   * Per-run Chrome profile name used for browser state isolation (spec
   * §5.1). The runner generates a unique name per run and hands it in
   * here; WebAdapter passes it to `chrome.startChrome()` so each run gets
   * its own `--user-data-dir`. On `close()` the adapter recursively
   * deletes that directory (local mode only; remote Chrome's data dir
   * is not under our control, and the remote branch resets state via
   * `clearBrowserData` on start instead). Must match the regex
   * `/^[a-zA-Z0-9_-]+$/` enforced by chrome-ws-lib.setProfileName.
   */
  chromeProfileName?: string;
  /**
   * Pins the browsing tab to a specific CSS-pixel viewport via
   * `Emulation.setDeviceMetricsOverride`. Applied once in `start()`
   * after the initial navigate. Omit to leave whatever default Chrome
   * picks — but every production path threads one in (default 1440x900
   * from AppConfig).
   */
  viewport?: Viewport;
  /**
   * PRI-1436: dependency-injection seam for tests. When provided, the
   * adapter uses this session instead of calling `createSession()`.
   * Production code never sets this — the adapter constructs its own
   * session from `options.chrome`.
   */
  chromeSession?: ChromeSession;
  /**
   * Caller-provided credential resolver. When set together with
   * contextRoot, the WebAdapter registers fetch_credential. PRI-1605.
   */
  credentialResolver?: CredentialResolverConfig;
}

export interface ScreenshotResult {
  image?: ToolResult["image"];
  imagePath?: string;
  screenshotSkipped?: string;
}

export function composeResult(
  text: string,
  screenshot: ScreenshotResult
): ToolResult {
  if (screenshot.screenshotSkipped) {
    return {
      text: `${text} (screenshot unavailable: ${screenshot.screenshotSkipped})`,
    };
  }
  // Always pass image + imagePath together — takeReturnScreenshot sets
  // them as a unit. If imagePath is set without image, that would be a
  // bug worth surfacing rather than silently dropping.
  return {
    text,
    ...(screenshot.image !== undefined && {
      image: screenshot.image,
      imagePath: screenshot.imagePath,
    }),
  };
}

export class WebAdapter implements Adapter {
  readonly name = "web";
  private remote: boolean;
  private readTool: ReadTool | null;
  private passkeyTool: PasskeyTool | null;
  private cookiesTool: CookiesTool | null;
  private credentialTool: FetchCredentialTool | null;
  private logger: EvidenceLogger | null;
  private observerSession: ObserverSession | null = null;
  private chromeProfileName: string | null;
  private viewport: Viewport | null;
  /** Lazy cache of tool name → parameter schema for O(1) validation. */
  private toolSchemas: Map<string, ToolDefinition["parameters"]> | null = null;
  /**
   * PRI-1436: per-WebAdapter chrome-ws-lib session. Concurrent web runs
   * in `gauntlet serve` each construct their own WebAdapter and therefore
   * their own session — no shared activePort / chromeProcess / profile
   * name / connection pool. Tests may inject a stubbed session via
   * `options.chromeSession`.
   */
  private chrome: ChromeSession;
  /**
   * PRI-1439: side-trip tab focus stack. Bottom is the original tab
   * opened during start(); each new_tab call pushes a new entry, each
   * close_tab pops. The top of the stack is the active tab — its
   * `wsUrl` is passed to every chrome-ws-lib dispatch. The companion
   * `url` field is the page URL the agent asked us to open (recorded
   * for evidence — `tab_focus_changed` events on push *and* pop both
   * carry it).
   *
   * Empty until start() seeds it; pre-start dispatches fall back to
   * tab index 0. Tests construct WebAdapter without start() and rely
   * on that fallback.
   */
  private tabStack: Array<{ wsUrl: string; url: string }> = [];

  /**
   * PRI-1535: BrowserContext for this adapter. Created in start(), disposed
   * in close(). Replaces the per-launch --user-data-dir as the per-test
   * isolation primitive. null until start() runs (and after close()).
   */
  private context: { browserContextId: string; createPage(url?: string): Promise<{
    id: string;
    targetId: string;
    webSocketDebuggerUrl: string;
    type: string;
    url: string;
    browserContextId: string;
  }>; dispose(): Promise<void> } | null = null;

  constructor(options?: WebAdapterOptions) {
    this.remote = false;
    // PRI-1436: each WebAdapter owns its own chrome-ws-lib session. The
    // session's hostOverride is seeded from options.chrome at construction
    // time.
    if (options?.chromeSession) {
      this.chrome = options.chromeSession;
      if (options?.chrome) {
        this.remote = true;
      }
    } else if (options?.chrome) {
      this.chrome = createSession({ host: options.chrome.host, port: options.chrome.port });
      this.remote = true;
    } else {
      this.chrome = createSession();
    }
    // If no chrome passed, chrome-ws-lib uses its startup defaults
    // (which come from host-override.js's mutable state — set by setDefaults
    // or seeded from CHROME_WS_HOST/CHROME_WS_PORT at module load).
    this.logger = options?.logger ?? null;
    this.chromeProfileName = options?.chromeProfileName ?? null;
    this.viewport = options?.viewport ?? null;
    this.readTool = options?.contextRoot
      ? buildReadTool(options.contextRoot)
      : null;
    this.passkeyTool = options?.contextRoot
      ? buildInstallPasskeyTool(
          options.contextRoot,
          PASSKEY_TAB,
          makeWebAuthnDriver(this.chrome),
          this.logger,
        )
      : null;
    this.cookiesTool = options?.contextRoot
      ? buildInstallCookiesTool(
          options.contextRoot,
          COOKIES_TAB,
          makeCookiesDriver(this.chrome),
          this.logger,
        )
      : null;
    this.credentialTool = buildFetchCredentialTool(
      options?.contextRoot ?? "",
      options?.credentialResolver,
    );
  }

  /**
   * PRI-1436: expose the per-instance chrome-ws-lib session so collaborators
   * (e.g. ScreencastStreamer) can talk to the same Chrome process this
   * adapter started, without going through a separate session whose
   * activePort would be unset.
   */
  getChromeSession(): ChromeSession {
    return this.chrome;
  }

  /**
   * PRI-1439: top of the focus stack — the WS URL or numeric index that
   * every dispatch routes to. Falls back to numeric 0 when the stack is
   * empty (legacy tests construct WebAdapter without calling start()).
   */
  private activeTab(): string | number {
    return this.tabStack.length > 0
      ? this.tabStack[this.tabStack.length - 1].wsUrl
      : 0;
  }

  /**
   * PRI-1535 (closes PRI-1439's structural blind spot): addressable wait
   * for a page-spawned popup. Register before the action that triggers
   * `window.open`; resolves on `Target.targetCreated` (event fires in
   * a few ms in headless Chromium 137).
   *
   * Currently a private helper — there's no public call-site that needs
   * it yet (the agent-initiated `new_tab` path uses `chrome.newTab`).
   * The side-trip-popup regression test drives the underlying
   * session.targets.waitForNew capability directly. This helper exists so
   * a future "click that may spawn a popup" path can adopt it without
   * re-deriving the listener-registration shape.
   */
  private async waitForPopupAfter<T>(
    parentTargetId: string,
    action: () => Promise<T>,
    { timeoutMs = 5000 }: { timeoutMs?: number } = {}
  ): Promise<{ result: T; popup: { targetId: string; openerId?: string; type: string; url: string } | null }> {
    const popupP = (this.chrome as unknown as {
      targets: {
        waitForNew(
          predicate: (t: { targetId: string; openerId?: string; type: string; url: string }) => boolean,
          opts?: { timeoutMs?: number },
        ): Promise<{ targetId: string; openerId?: string; type: string; url: string }>;
      };
    }).targets.waitForNew(
      (t) => t.openerId === parentTargetId && t.type === "page",
      { timeoutMs }
    );
    let result: T;
    try {
      result = await action();
    } catch (e) {
      // even if the action threw, drain the wait so we don't leak a listener
      popupP.catch(() => {});
      throw e;
    }
    let popup: { targetId: string; openerId?: string; type: string; url: string } | null = null;
    try { popup = await popupP; } catch { /* no popup is fine */ }
    return { result, popup };
  }

  async start(url: string): Promise<void> {
    if (!this.remote) {
      // Pass the per-run profile name (spec §5.1) so each run gets its
      // own --user-data-dir. Falls back to chrome-ws-lib's default when
      // the runner did not provide one (kept for test backwards-compat).
      await this.chrome.startChrome(true, this.chromeProfileName ?? null); // headless
    }

    // PRI-1535: one BrowserContext per WebAdapter — atomic isolation primitive
    // replacing the per-launch --user-data-dir for cleanup. createBrowserContext
    // lazy-opens the browser-WS under the hood. createPage navigates the new
    // page to the target URL, so no separate navigate(0, url) is needed.
    const ctx = await this.chrome.createBrowserContext();
    this.context = ctx;
    const page = await ctx.createPage(url);

    // Seed the focus stack with the page's WS URL (PRI-1439).
    this.tabStack.push({
      wsUrl: page.webSocketDebuggerUrl,
      url: page.url ?? url,
    });

    // Pin the viewport against this specific page's WS URL — under
    // BrowserContext-per-adapter, getTabs()[0] is no longer guaranteed to
    // be our page. Best-effort: a failed viewport override does not fail
    // the run, since --window-size already gives a reasonable default.
    if (this.viewport) {
      try {
        await this.chrome.setViewport(page.webSocketDebuggerUrl, {
          width: this.viewport.width,
          height: this.viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
      } catch (err) {
        this.logger?.logEvent("set_viewport_failed", {
          reason: err instanceof Error ? err.message : String(err),
          requested: this.viewport,
        });
      }
    }

    // PRI-1535: the previous remote-only `clearBrowserData(0)` call is gone —
    // a fresh BrowserContext starts clean by construction.

    // Open the observer session against the page's WS URL (not numeric 0).
    // Runs *after* the page is created so the initial load and LiveSocket
    // handshake are captured as the first events we see.
    if (this.logger) {
      const logger = this.logger;
      try {
        this.observerSession = await this.chrome.openObserverSession(
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

  describeTarget(target: string): string {
    return `The application is available at: ${target}`;
  }

  defaultViewport(): Viewport {
    // Reflect the viewport this instance is actually using: whatever
    // the constructor was handed, or the documented fallback when none
    // was supplied.
    return this.viewport ?? DEFAULT_VIEWPORT;
  }

  async close(): Promise<void> {
    // Close the observer first so it stops trying to drain events from
    // a dying target.
    if (this.observerSession) {
      try {
        this.observerSession.close();
      } catch {
        // best-effort
      }
      this.observerSession = null;
    }
    // PRI-1439: pop and close any side-trip tabs the agent left open
    // (anything pushed above the original). The original tab is left
    // alone — it'll go away when killChrome() runs (local) or be reset
    // by the next run via clearBrowserData (remote). Each force-close
    // emits a `tab_focus_changed` pop so the run.jsonl timeline shows
    // every push paired with a pop.
    while (this.tabStack.length > 1) {
      const popped = this.tabStack.pop()!;
      this.logger?.logEvent("tab_focus_changed", {
        action: "pop",
        depth: this.tabStack.length,
        ws_url: popped.wsUrl,
        url: popped.url,
        reason: "adapter_close",
      });
      try {
        await this.chrome.closeTab(popped.wsUrl);
      } catch (err) {
        this.logger?.logEvent("tab_force_close_failed", {
          ws_url: popped.wsUrl,
          url: popped.url,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Drop the original tab from the stack so a reused adapter would
    // start clean. Reuse isn't a current code path, but the inconsistent
    // post-close state is an easy footgun.
    this.tabStack = [];

    // PRI-1535: dispose the BrowserContext atomically. Runs AFTER the
    // side-trip pop loop (which relies on per-page WS being usable for
    // closeTab) and BEFORE killChrome / passkey teardown. Chrome tears
    // down cookies/storage/IDB/SW for the context in one call, replacing
    // the inline clearBrowserData sweep that used to live in start().
    if (this.context) {
      try {
        await this.context.dispose();
      } catch (err) {
        this.logger?.logEvent("browser_context_dispose_failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      this.context = null;
    }
    // Tear the virtual authenticator down before killing Chrome so that
    // remote Chrome sessions (where we didn't start the process) don't
    // leak state across runs. For locally-spawned Chrome, killChrome
    // makes this a best-effort no-op — errors are swallowed inside.
    if (this.passkeyTool) {
      await this.passkeyTool.teardown();
    }
    if (!this.remote) {
      await this.chrome.killChrome();
      // Recursively delete the per-run Chrome profile directory (spec
      // §5.1). Best-effort: failures are logged as an action-log entry
      // but never thrown — a leftover stale dir is preferable to
      // failing the close path. Skipped when no profile name was
      // provided (e.g., legacy/test usage without a runner).
      if (this.chromeProfileName) {
        const dir = this.chrome.getChromeProfileDir(this.chromeProfileName);
        try {
          await rm(dir, { recursive: true, force: true });
        } catch (err) {
          this.logger?.logEvent("chrome_profile_cleanup_failed", {
            dir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  isMutatingTool(name: string): boolean {
    return WEB_MUTATING_TOOLS.has(name);
  }

  toolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: "screenshot",
        description:
          "Capture rendered pixels of the page or an element. Use for " +
          "anything visual (images, icons, SVG, canvas, layout, color) — " +
          "`extract` only returns DOM text.",
        parameters: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector to screenshot a specific element",
            },
            fullPage: {
              type: "boolean",
              description: "Capture the full scrollable page",
            },
          },
        },
      },
      {
        name: "click",
        description:
          "Click an element matching the given selector. Supports CSS " +
          "selectors, XPath (starts with `/`), and jQuery-style " +
          "`:contains('text')` for matching by text content (e.g. " +
          "`button:contains('Log in')`). Reports an Error result if the " +
          "element cannot be found — if the result starts with 'Error:', " +
          "the click did NOT happen and the page state is unchanged.",
        parameters: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description:
                "Selector of the element to click. CSS (e.g. `#foo .btn`), XPath (e.g. `//button[text()='Log in']`), or CSS + jQuery-style `:contains('text')`.",
            },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["selector"],
        },
      },
      {
        name: "type",
        description:
          "Type text into an element. If selector is provided, clicks it first then fills.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to type" },
            selector: {
              type: "string",
              description: "CSS selector of the input element",
            },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "press",
        description:
          "Press a special key (Enter, Tab, Escape, ArrowDown, etc.)",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Key name to press" },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["key"],
        },
      },
      {
        name: "hover",
        description:
          "Move the mouse over an element (fires CSS :hover, tooltips, " +
          "hover-to-reveal menus). Uses CDP mouse events, not synthetic " +
          "JS — will fire real pointer/mouse listeners on the page.",
        parameters: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "Selector of the element to hover over (CSS, XPath, or :contains()).",
            },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["selector"],
        },
      },
      {
        name: "double_click",
        description: "Double-click an element. Fires two clicks plus dblclick.",
        parameters: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "Selector of the element to double-click.",
            },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["selector"],
        },
      },
      {
        name: "right_click",
        description:
          "Right-click an element (fires contextmenu). Use when you need " +
          "to open a context menu — does not dismiss the menu on its own.",
        parameters: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "Selector of the element to right-click.",
            },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["selector"],
        },
      },
      {
        name: "drag",
        description:
          "Drag an element to a target (native DnD pipeline via CDP mouse " +
          "events, so drop handlers receive a real DataTransfer). Target is " +
          "either another selector or explicit {x, y} coordinates.",
        parameters: {
          type: "object",
          properties: {
            source_selector: {
              type: "string",
              description: "Selector of the element to drag.",
            },
            target_selector: {
              type: "string",
              description: "Selector of the drop target. Provide this OR target_x+target_y.",
            },
            target_x: {
              type: "number",
              description: "Drop-target X coordinate (viewport pixels). Use with target_y.",
            },
            target_y: {
              type: "number",
              description: "Drop-target Y coordinate (viewport pixels). Use with target_x.",
            },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["source_selector"],
        },
      },
      {
        name: "mouse_move",
        description:
          "Move the mouse to (x, y) in viewport coordinates. Used for hover " +
          "effects at arbitrary points or for bot-detection puzzles that " +
          "track pointer trajectories.",
        parameters: {
          type: "object",
          properties: {
            x: { type: "number", description: "Target X coordinate (viewport pixels)." },
            y: { type: "number", description: "Target Y coordinate (viewport pixels)." },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["x", "y"],
        },
      },
      {
        name: "scroll",
        description:
          "Scroll the page (or an element) using real mouse-wheel CDP events. " +
          "More natural than JS scrollTo, which bot detectors can flag.",
        parameters: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: ["up", "down", "left", "right"],
              description: "Scroll direction.",
            },
            amount: {
              type: "number",
              description: "Pixels to scroll. Defaults to 300.",
            },
            selector: {
              type: "string",
              description: "Optional selector to scroll from (wheel event anchored at its center).",
            },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["direction"],
        },
      },
      {
        name: "file_upload",
        description:
          "Upload local files to an <input type=file> element via " +
          "DOM.setFileInputFiles — the only way to programmatically set " +
          "files (JS cannot). File paths must be absolute.",
        parameters: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "Selector of the file input.",
            },
            file_paths: {
              type: "array",
              items: { type: "string" },
              description: "Absolute paths of files to upload.",
            },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["selector", "file_paths"],
        },
      },
      {
        name: "navigate",
        description: "Navigate the browser to a URL",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to navigate to" },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "extract",
        description:
          "Return the DOM text of the page or an element — text only. " +
          "Images, SVG, canvas, and CSS backgrounds aren't seen; use " +
          "`screenshot` for visual checks.",
        parameters: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description:
                "CSS selector to extract from. Omit for full page markdown.",
            },
          },
        },
      },
      // `eval` is intentionally not exposed (PRI-1590 experiment). The
      // executor below still implements it so re-enabling is one line, but
      // keeping it out of toolDefinitions() removes its pull on the agent
      // toward developer-pattern escapes (form.submit(), raw fetch, etc.).
      {
        name: "wait_for",
        description: "Wait for an element or text to appear on the page",
        parameters: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector to wait for",
            },
            text: {
              type: "string",
              description: "Text content to wait for",
            },
            timeout: {
              type: "number",
              description: "Timeout in milliseconds (default 5000)",
            },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
        },
      },
      {
        name: "new_tab",
        description:
          "Open a new browser tab in the foreground for a side trip — " +
          "fetching an OTP from email, retrieving a credential from a " +
          "password manager, completing a 2FA portal handoff. Subsequent " +
          "tool calls operate on the new tab. Use `close_tab` when done " +
          "to return to the original page with its form values, cookies, " +
          "and scroll position intact. Do NOT use `navigate` for side " +
          "trips — it resets the original page state.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Absolute URL to open in the new tab.",
            },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot the new tab after it loads.",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "close_tab",
        description:
          "Close the current side-trip tab and return focus to the " +
          "previous tab. Use this when finished with a side trip opened " +
          "via `new_tab`. Cannot close the original tab — for primary " +
          "navigation use `navigate` instead.",
        parameters: {
          type: "object",
          properties: {
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot the now-active tab after closing.",
            },
          },
        },
      },
    ];
    if (this.readTool) {
      tools.push(this.readTool.definition);
    }
    if (this.passkeyTool) {
      tools.push(this.passkeyTool.definition);
    }
    if (this.cookiesTool) {
      tools.push(this.cookiesTool.definition);
    }
    if (this.credentialTool) tools.push(this.credentialTool.definition);
    return tools;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    logger: EvidenceLogger
  ): Promise<ToolResult> {
    // Validate the LLM's args shape against the tool schema before dispatch.
    // A bad shape (e.g. `selector: {css: "#foo"}` where string expected)
    // gets reported back to the LLM as a normal tool result so the next
    // turn can correct — no exceptions, no silent cast.
    if (!this.toolSchemas) {
      this.toolSchemas = new Map(
        this.toolDefinitions().map((t) => [t.name, t.parameters] as const),
      );
    }
    const schema = this.toolSchemas.get(name);
    if (schema) {
      const check = validateToolArgs(name, args, schema);
      if (!check.ok) {
        return { text: `Error: invalid args for ${name}: ${check.reason}` };
      }
    }

    if (name === "read" && this.readTool) {
      return this.readTool.execute(args);
    }

    // PRI-1439: install_passkey / install_cookies target tab index 0
    // (the original tab) by construction. Cookies are origin-scoped, so
    // tab routing is irrelevant. WebAuthn is per-target, but Chrome's
    // /json typically reports the original (created-first) tab as
    // pageTabs[0] even when a side-trip tab is open in the foreground.
    // We log a warning at depth > 1 so any wrong-tab incident shows up
    // in run.jsonl rather than as a silent agent failure. Full fix —
    // routing these tools to the seeded WS URL — is tracked separately.
    if (name === "install_passkey" && this.passkeyTool) {
      if (this.tabStack.length > 1) {
        logger.logEvent("install_at_depth_warning", {
          tool: name,
          depth: this.tabStack.length,
          note: "install_passkey targets tab index 0 by construction; verify it landed on the intended target",
        });
      }
      return this.passkeyTool.execute(args);
    }

    if (name === "install_cookies" && this.cookiesTool) {
      if (this.tabStack.length > 1) {
        logger.logEvent("install_at_depth_warning", {
          tool: name,
          depth: this.tabStack.length,
          note: "install_cookies sets origin-scoped state on tab index 0; cookies are browser-wide so this is usually fine",
        });
      }
      return this.cookiesTool.execute(args);
    }

    if (name === "fetch_credential" && this.credentialTool) {
      return this.credentialTool.execute(args, logger);
    }

    const tab = this.activeTab();

    const takeReturnScreenshot = async (
      tabOverride?: typeof tab
    ): Promise<ScreenshotResult> => {
      if (!args.return_screenshot) return {};
      const targetTab = tabOverride ?? tab;
      const t0 = Date.now();
      const tmpFile = join(tmpdir(), `gauntlet-screenshot-${Date.now()}.png`);
      try {
        await this.chrome.screenshot(targetTab, tmpFile, null, false, {
          timeoutMs: RETURN_SCREENSHOT_TIMEOUT_MS,
        });
        const data = readFileSync(tmpFile);
        const imagePath = logger.saveScreenshot(Buffer.from(data));
        try { unlinkSync(tmpFile); } catch { /* best-effort */ }
        return {
          image: { data: Buffer.from(data).toString("base64"), mediaType: "image/png" },
          imagePath,
        };
      } catch (err) {
        try { unlinkSync(tmpFile); } catch { /* best-effort */ }
        const reason = err instanceof Error ? err.message : String(err);
        const elapsed = Date.now() - t0;
        console.warn(
          `[gauntlet] return_screenshot skipped (${name}, ${elapsed}ms): ${reason}`
        );
        return { screenshotSkipped: reason };
      }
    };

    switch (name) {
      case "screenshot": {
        const tmpFile = join(
          tmpdir(),
          `gauntlet-screenshot-${Date.now()}.png`
        );
        await this.chrome.screenshot(
          tab,
          tmpFile,
          (args.selector as string) ?? null,
          (args.fullPage as boolean) ?? false
        );
        const data = readFileSync(tmpFile);
        const saved = logger.saveScreenshot(Buffer.from(data));
        try {
          unlinkSync(tmpFile);
        } catch {
          // temp file cleanup is best-effort
        }
        return {
          text: `Screenshot saved to ${saved}`,
          image: { data: Buffer.from(data).toString("base64"), mediaType: "image/png" },
          imagePath: saved,
        };
      }
      case "click": {
        try {
          const result = await this.chrome.click(tab, args.selector as string);
          const note = result?.fallback
            ? ` (fallback: ${result.fallback})`
            : "";
          return composeResult(
            `clicked ${args.selector}${note}`,
            await takeReturnScreenshot()
          );
        } catch (err) {
          // Make failures visible to the agent. A silent "clicked" when
          // nothing actually got clicked is a classic way to waste 40
          // turns.
          const reason = err instanceof Error ? err.message : String(err);
          return composeResult(
            `Error: ${reason}`,
            await takeReturnScreenshot()
          );
        }
      }
      case "type": {
        const selector = args.selector as string | undefined;
        const text = args.text as string;
        if (selector) {
          await this.chrome.fill(tab, selector, text);
        } else {
          // No selector — type via keyboard
          for (const char of text) {
            await this.chrome.keyboardPress(tab, char);
          }
        }
        return composeResult("typed", await takeReturnScreenshot());
      }
      case "press": {
        await this.chrome.keyboardPress(tab, args.key as string);
        return composeResult("pressed", await takeReturnScreenshot());
      }
      case "hover": {
        try {
          await this.chrome.hover(tab, args.selector as string);
          return composeResult(`hovered ${args.selector}`, await takeReturnScreenshot());
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return composeResult(`Error: ${reason}`, await takeReturnScreenshot());
        }
      }
      case "double_click": {
        try {
          await this.chrome.doubleClick(tab, args.selector as string);
          return composeResult(`double-clicked ${args.selector}`, await takeReturnScreenshot());
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return composeResult(`Error: ${reason}`, await takeReturnScreenshot());
        }
      }
      case "right_click": {
        try {
          await this.chrome.rightClick(tab, args.selector as string);
          return composeResult(`right-clicked ${args.selector}`, await takeReturnScreenshot());
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return composeResult(`Error: ${reason}`, await takeReturnScreenshot());
        }
      }
      case "drag": {
        const sourceSelector = args.source_selector as string;
        const targetSelector = args.target_selector as string | undefined;
        const targetX = args.target_x as number | undefined;
        const targetY = args.target_y as number | undefined;
        // Agent supplies target_selector XOR (target_x AND target_y).
        // A real validation error — not something the lib will diagnose
        // helpfully — so catch it here with a pointer back to the schema.
        let target: string | { x: number; y: number };
        if (targetSelector) {
          target = targetSelector;
        } else if (typeof targetX === "number" && typeof targetY === "number") {
          target = { x: targetX, y: targetY };
        } else {
          return {
            text: "Error: drag requires either target_selector or both target_x and target_y",
          };
        }
        try {
          await this.chrome.drag(tab, sourceSelector, target);
          return composeResult(`dragged ${sourceSelector}`, await takeReturnScreenshot());
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return composeResult(`Error: ${reason}`, await takeReturnScreenshot());
        }
      }
      case "mouse_move": {
        await this.chrome.mouseMove(tab, args.x as number, args.y as number);
        return composeResult(`moved mouse to (${args.x}, ${args.y})`, await takeReturnScreenshot());
      }
      case "scroll": {
        const direction = args.direction as "up" | "down" | "left" | "right";
        const amount = (args.amount as number) ?? 300;
        // Map direction → wheel delta. Chrome's mouseWheel uses +y=down,
        // +x=right, which matches intuitive direction names.
        const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
        const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
        await this.chrome.scroll(tab, {
          deltaX,
          deltaY,
          selector: (args.selector as string) ?? undefined,
        });
        return composeResult(`scrolled ${direction} ${amount}px`, await takeReturnScreenshot());
      }
      case "file_upload": {
        try {
          const result = await this.chrome.fileUpload(
            tab,
            args.selector as string,
            args.file_paths as string[],
          );
          return composeResult(
            `uploaded ${result.files} file(s) to ${args.selector}`,
            await takeReturnScreenshot()
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return composeResult(`Error: ${reason}`, await takeReturnScreenshot());
        }
      }
      case "navigate": {
        await this.chrome.navigate(tab, args.url as string);
        return composeResult("navigated", await takeReturnScreenshot());
      }
      case "extract": {
        const selector = args.selector as string | undefined;
        if (selector) {
          const text = await this.chrome.extractText(tab, selector);
          return { text };
        }
        // Return the full markdown inline so the model can read it. The
        // logger will spill to artifacts/N.txt for run.jsonl readability
        // when the text exceeds its inline limit, but that's a
        // reviewer-facing concern — the model has already consumed the
        // content by the time logging happens.
        const markdown = await this.chrome.generateMarkdown(tab);
        return { text: markdown };
      }
      case "eval": {
        const result = await this.chrome.evaluate(tab, args.expression as string);
        const text = result === undefined ? "undefined" : (typeof result === "string" ? result : JSON.stringify(result));
        return composeResult(text, await takeReturnScreenshot());
      }
      case "wait_for": {
        const timeout = (args.timeout as number) ?? 5000;
        if (args.selector) {
          await this.chrome.waitForElement(tab, args.selector as string, timeout);
          return composeResult("element found", await takeReturnScreenshot());
        }
        if (args.text) {
          await this.chrome.waitForText(tab, args.text as string, timeout);
          return composeResult("text found", await takeReturnScreenshot());
        }
        return { text: "nothing to wait for — provide selector or text" };
      }
      case "new_tab": {
        // The cap is on total stack depth (1 original + N side trips).
        // Frame the user-facing error in side-trip terms so the agent
        // can plan against the number it cares about.
        if (this.tabStack.length >= MAX_TAB_DEPTH) {
          return {
            text:
              `Error: too many side-trip tabs (max ${MAX_TAB_DEPTH - 1}; ` +
              `close one with close_tab before opening another)`,
          };
        }
        const targetUrl = args.url as string | undefined;
        // Empty / non-http URLs would otherwise become about:blank and
        // silently consume a stack slot — refuse explicitly so the
        // agent doesn't waste turns.
        if (
          typeof targetUrl !== "string" ||
          !/^(https?:|file:|about:)/i.test(targetUrl)
        ) {
          return {
            text:
              "Error: new_tab requires an absolute URL (http://, https://, " +
              "file://, or about:)",
          };
        }
        try {
          const created = await this.chrome.newTab(targetUrl);
          const wsUrl = created?.webSocketDebuggerUrl as string | undefined;
          if (!wsUrl) {
            return { text: "Error: chrome did not return a tab WebSocket URL" };
          }
          this.tabStack.push({ wsUrl, url: targetUrl });
          logger.logEvent("tab_focus_changed", {
            action: "push",
            depth: this.tabStack.length,
            ws_url: wsUrl,
            url: targetUrl,
          });
          // Recompute against the now-pushed tab so return_screenshot
          // captures the *new* tab, not the one we just left.
          const newActive = this.activeTab();
          return composeResult(
            `opened tab (depth ${this.tabStack.length})`,
            await takeReturnScreenshot(newActive)
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { text: `Error: ${reason}` };
        }
      }
      case "close_tab": {
        if (this.tabStack.length <= 1) {
          return {
            text: "Error: cannot close the original tab — use navigate to change the page",
          };
        }
        const popped = this.tabStack.pop()!;
        logger.logEvent("tab_focus_changed", {
          action: "pop",
          depth: this.tabStack.length,
          ws_url: popped.wsUrl,
          url: popped.url,
        });
        let closeWarning = "";
        try {
          await this.chrome.closeTab(popped.wsUrl);
        } catch (err) {
          // Surface the chrome-side failure so the agent knows the tab
          // *might* still exist in Chrome (its stack-mutation already
          // happened — focus has moved). Worst case the orphan is GC'd
          // when the run ends.
          const reason = err instanceof Error ? err.message : String(err);
          closeWarning = ` (warning: chrome closeTab failed — ${reason})`;
          logger.logEvent("tab_force_close_failed", {
            ws_url: popped.wsUrl,
            url: popped.url,
            reason,
          });
        }
        // Same fix as new_tab: return_screenshot must hit the *now-active*
        // tab (the one we popped back to), not the just-closed tab.
        const newActive = this.activeTab();
        return composeResult(
          `closed tab (depth ${this.tabStack.length})${closeWarning}`,
          await takeReturnScreenshot(newActive)
        );
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
