import { join } from "path";
import type { Adapter } from "../adapter";
import { textResult, type ToolDefinition, type ToolResult } from "../../models/provider";
import type { EvidenceLogger } from "../../evidence/logger";
import { DEFAULT_VIEWPORT, type ChromeEndpoint, type Viewport } from "../../config";
import type { CredentialResolverConfig } from "../../config";
import { buildSharedTools, type SharedTools } from "../../agent/shared-tools";
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
import { webToolDefinitions } from "./tool-defs";
import { executeScreenshot, executeExtract, executeWaitFor } from "./tools/visual";
import {
  executeClick,
  executeHover,
  executeDoubleClick,
  executeRightClick,
  executeDrag,
  executeMouseMove,
  executeScroll,
} from "./tools/pointer";
import { executeType, executePress } from "./tools/keyboard";
import { executeNavigate, executeEval, executeFileUpload } from "./tools/page-actions";
import {
  startWebAdapter,
  closeWebAdapter,
  type WebLifecycleState,
} from "./lifecycle";
import { buildReturnScreenshot } from "./tools/return-screenshot";
import {
  executeNewTab,
  executeCloseTab,
  MAX_TAB_DEPTH,
  type WebTabsCtx,
} from "./tools/tabs";
import type { WebToolCtx } from "./tools/types";

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
  /**
   * Per-run directory. Used in Task 11 to derive the bash tool's cwd.
   * Optional only so the registry's tool-introspection construction
   * (which never executes tools) still works.
   */
  runDir?: string;
}

export interface ScreenshotResult {
  image?: { data: string; mediaType: string };
  imagePath?: string;
  screenshotSkipped?: string;
}

export function composeResult(
  text: string,
  screenshot: ScreenshotResult
): ToolResult {
  if (screenshot.screenshotSkipped) {
    return textResult(
      `${text} (screenshot unavailable: ${screenshot.screenshotSkipped})`,
    );
  }
  // Always pass image + imagePath together — takeReturnScreenshot sets
  // them as a unit. If imagePath is set without image, that would be a
  // bug worth surfacing rather than silently dropping.
  if (screenshot.image === undefined) {
    return textResult(text);
  }
  return {
    kind: "image",
    text,
    image: screenshot.image,
    imagePath: screenshot.imagePath,
  };
}

export class WebAdapter implements Adapter {
  readonly name = "web";
  private remote: boolean;
  private shared: SharedTools;
  private passkeyTool: PasskeyTool | null;
  private cookiesTool: CookiesTool | null;
  private logger: EvidenceLogger | null;
  private runDir: string | undefined;
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
    this.runDir = options?.runDir;
    this.shared = buildSharedTools({
      contextRoot: options?.contextRoot,
      credentialResolver: options?.credentialResolver,
      cwd: options?.runDir ? join(options.runDir, "scratch") : undefined,
    });
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
    const state = this.lifecycleState();
    await startWebAdapter(state, url);
    // Copy mutated fields back to the class instance.
    this.context = state.context;
    this.observerSession = state.observerSession;
  }

  /**
   * Build a mutable lifecycle-state view over this adapter's fields.
   * The lifecycle helpers mutate `tabStack` in place and reassign
   * `context` / `observerSession` on the struct; the caller copies
   * those reassignments back onto `this` after the call.
   */
  private lifecycleState(): WebLifecycleState {
    return {
      remote: this.remote,
      chrome: this.chrome,
      chromeProfileName: this.chromeProfileName,
      viewport: this.viewport,
      logger: this.logger,
      passkeyTool: this.passkeyTool,
      tabStack: this.tabStack,
      context: this.context,
      observerSession: this.observerSession,
    };
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
    const state = this.lifecycleState();
    await closeWebAdapter(state);
    this.context = state.context;
    this.observerSession = state.observerSession;
  }

  isMutatingTool(name: string): boolean {
    return WEB_MUTATING_TOOLS.has(name);
  }

  toolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = webToolDefinitions();
    if (this.passkeyTool) {
      tools.push(this.passkeyTool.definition);
    }
    if (this.cookiesTool) {
      tools.push(this.cookiesTool.definition);
    }
    tools.push(...this.shared.definitions());
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
        return textResult(`Error: invalid args for ${name}: ${check.reason}`);
      }
    }

    if (this.shared.canExecute(name)) {
      return this.shared.execute(name, args, logger);
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

    const tab = this.activeTab();
    const takeReturnScreenshot = buildReturnScreenshot({
      chrome: this.chrome,
      defaultTab: tab,
      logger,
      toolName: name,
      args,
    });

    const ctx: WebToolCtx = {
      chrome: this.chrome,
      tab,
      logger,
      takeReturnScreenshot,
    };

    const tabsCtx: WebTabsCtx = {
      ...ctx,
      tabStack: this.tabStack,
      recomputeActiveTab: () => this.activeTab(),
    };

    switch (name) {
      case "screenshot":
        return executeScreenshot(ctx, args);
      case "click":
        return executeClick(ctx, args);
      case "type":
        return executeType(ctx, args);
      case "press":
        return executePress(ctx, args);
      case "hover":
        return executeHover(ctx, args);
      case "double_click":
        return executeDoubleClick(ctx, args);
      case "right_click":
        return executeRightClick(ctx, args);
      case "drag":
        return executeDrag(ctx, args);
      case "mouse_move":
        return executeMouseMove(ctx, args);
      case "scroll":
        return executeScroll(ctx, args);
      case "file_upload":
        return executeFileUpload(ctx, args);
      case "navigate":
        return executeNavigate(ctx, args);
      case "extract":
        return executeExtract(ctx, args);
      case "eval":
        return executeEval(ctx, args);
      case "wait_for":
        return executeWaitFor(ctx, args);
      case "new_tab":
        return executeNewTab(tabsCtx, args);
      case "close_tab":
        return executeCloseTab(tabsCtx, args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
