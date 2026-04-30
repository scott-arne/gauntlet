import { readFileSync, unlinkSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Adapter } from "../adapter";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger, BrowserEventCategory } from "../../evidence/logger";
import { DEFAULT_VIEWPORT, type ChromeEndpoint, type Viewport } from "../../config";
import { buildReadTool, type ReadTool } from "../../context/read-tool";
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

// Passkey and cookies tools both act on tab index 0, matching the rest
// of this adapter.
const PASSKEY_TAB = 0;
const COOKIES_TAB = 0;

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
}

export class WebAdapter implements Adapter {
  readonly name = "web";
  private remote: boolean;
  private readTool: ReadTool | null;
  private passkeyTool: PasskeyTool | null;
  private cookiesTool: CookiesTool | null;
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

  constructor(options?: WebAdapterOptions) {
    this.remote = false;
    // PRI-1436: each WebAdapter owns its own chrome-ws-lib session. The
    // session's hostOverride is seeded from options.chrome at construction
    // time — no module-level setEndpoint mutation.
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

  async start(url: string): Promise<void> {
    if (!this.remote) {
      // Pass the per-run profile name (spec §5.1) so each run gets its
      // own --user-data-dir. Falls back to chrome-ws-lib's default when
      // the runner did not provide one (kept for test backwards-compat).
      await this.chrome.startChrome(true, this.chromeProfileName ?? null); // headless
    }
    await this.chrome.navigate(0, url);

    // Pin the viewport before the observer opens so any downstream
    // layout/resize events are captured as initial state. Best-effort:
    // a failing viewport override should not fail the run, since the
    // window-size flag already gives us a reasonable default.
    if (this.viewport) {
      try {
        await this.chrome.setViewport(0, {
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

    // Remote-Chrome state reset (spec §5.1): we cannot delete the
    // remote's --user-data-dir ourselves, so we fall back to a
    // best-effort CDP-level clear. Happens after the initial navigate
    // (so `location.origin` is populated) and BEFORE the observer
    // session opens (so the clear is not itself streamed as a noisy
    // first event).
    if (this.remote) {
      await this.chrome.clearBrowserData(0);
    }

    // Open the observer session *after* navigation so the initial page
    // load and LiveSocket handshake are captured as the first events we see.
    if (this.logger) {
      const logger = this.logger;
      try {
        this.observerSession = await this.chrome.openObserverSession(
          0,
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
      {
        name: "eval",
        description: "Evaluate a JavaScript expression in the page context",
        parameters: {
          type: "object",
          properties: {
            expression: {
              type: "string",
              description: "JavaScript expression to evaluate",
            },
            return_screenshot: {
              type: "boolean",
              description:
                "Screenshot after the action. Set true when the outcome " +
                "is visual (image loads, modal/chart appears, layout shifts).",
            },
          },
          required: ["expression"],
        },
      },
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

    if (name === "install_passkey" && this.passkeyTool) {
      return this.passkeyTool.execute(args);
    }

    if (name === "install_cookies" && this.cookiesTool) {
      return this.cookiesTool.execute(args);
    }

    const takeReturnScreenshot = async (): Promise<{ image?: ToolResult["image"]; imagePath?: string }> => {
      if (!args.return_screenshot) return {};
      const tmpFile = join(tmpdir(), `gauntlet-screenshot-${Date.now()}.png`);
      await this.chrome.screenshot(0, tmpFile, null, false);
      const data = readFileSync(tmpFile);
      const imagePath = logger.saveScreenshot(Buffer.from(data));
      try { unlinkSync(tmpFile); } catch { }
      return { image: { data: Buffer.from(data).toString("base64"), mediaType: "image/png" }, imagePath };
    };

    switch (name) {
      case "screenshot": {
        const tmpFile = join(
          tmpdir(),
          `gauntlet-screenshot-${Date.now()}.png`
        );
        await this.chrome.screenshot(
          0,
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
          const result = await this.chrome.click(0, args.selector as string);
          const note = result?.fallback
            ? ` (fallback: ${result.fallback})`
            : "";
          return {
            text: `clicked ${args.selector}${note}`,
            ...await takeReturnScreenshot(),
          };
        } catch (err) {
          // Make failures visible to the agent. A silent "clicked" when
          // nothing actually got clicked is a classic way to waste 40
          // turns.
          const reason = err instanceof Error ? err.message : String(err);
          return {
            text: `Error: ${reason}`,
            ...await takeReturnScreenshot(),
          };
        }
      }
      case "type": {
        const selector = args.selector as string | undefined;
        const text = args.text as string;
        if (selector) {
          await this.chrome.fill(0, selector, text);
        } else {
          // No selector — type via keyboard
          for (const char of text) {
            await this.chrome.keyboardPress(0, char);
          }
        }
        return { text: "typed", ...await takeReturnScreenshot() };
      }
      case "press": {
        await this.chrome.keyboardPress(0, args.key as string);
        return { text: "pressed", ...await takeReturnScreenshot() };
      }
      case "hover": {
        try {
          await this.chrome.hover(0, args.selector as string);
          return { text: `hovered ${args.selector}`, ...await takeReturnScreenshot() };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { text: `Error: ${reason}`, ...await takeReturnScreenshot() };
        }
      }
      case "double_click": {
        try {
          await this.chrome.doubleClick(0, args.selector as string);
          return { text: `double-clicked ${args.selector}`, ...await takeReturnScreenshot() };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { text: `Error: ${reason}`, ...await takeReturnScreenshot() };
        }
      }
      case "right_click": {
        try {
          await this.chrome.rightClick(0, args.selector as string);
          return { text: `right-clicked ${args.selector}`, ...await takeReturnScreenshot() };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { text: `Error: ${reason}`, ...await takeReturnScreenshot() };
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
          await this.chrome.drag(0, sourceSelector, target);
          return { text: `dragged ${sourceSelector}`, ...await takeReturnScreenshot() };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { text: `Error: ${reason}`, ...await takeReturnScreenshot() };
        }
      }
      case "mouse_move": {
        await this.chrome.mouseMove(0, args.x as number, args.y as number);
        return { text: `moved mouse to (${args.x}, ${args.y})`, ...await takeReturnScreenshot() };
      }
      case "scroll": {
        const direction = args.direction as "up" | "down" | "left" | "right";
        const amount = (args.amount as number) ?? 300;
        // Map direction → wheel delta. Chrome's mouseWheel uses +y=down,
        // +x=right, which matches intuitive direction names.
        const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
        const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
        await this.chrome.scroll(0, {
          deltaX,
          deltaY,
          selector: (args.selector as string) ?? undefined,
        });
        return { text: `scrolled ${direction} ${amount}px`, ...await takeReturnScreenshot() };
      }
      case "file_upload": {
        try {
          const result = await this.chrome.fileUpload(
            0,
            args.selector as string,
            args.file_paths as string[],
          );
          return {
            text: `uploaded ${result.files} file(s) to ${args.selector}`,
            ...await takeReturnScreenshot(),
          };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { text: `Error: ${reason}`, ...await takeReturnScreenshot() };
        }
      }
      case "navigate": {
        await this.chrome.navigate(0, args.url as string);
        return { text: "navigated", ...await takeReturnScreenshot() };
      }
      case "extract": {
        const selector = args.selector as string | undefined;
        if (selector) {
          const text = await this.chrome.extractText(0, selector);
          return { text };
        }
        // Return the full markdown inline so the model can read it. The
        // logger will spill to artifacts/N.txt for run.jsonl readability
        // when the text exceeds its inline limit, but that's a
        // reviewer-facing concern — the model has already consumed the
        // content by the time logging happens.
        const markdown = await this.chrome.generateMarkdown(0);
        return { text: markdown };
      }
      case "eval": {
        const result = await this.chrome.evaluate(0, args.expression as string);
        const text = result === undefined ? "undefined" : (typeof result === "string" ? result : JSON.stringify(result));
        return { text, ...await takeReturnScreenshot() };
      }
      case "wait_for": {
        const timeout = (args.timeout as number) ?? 5000;
        if (args.selector) {
          await this.chrome.waitForElement(0, args.selector as string, timeout);
          return { text: "element found", ...await takeReturnScreenshot() };
        }
        if (args.text) {
          await this.chrome.waitForText(0, args.text as string, timeout);
          return { text: "text found", ...await takeReturnScreenshot() };
        }
        return { text: "nothing to wait for — provide selector or text" };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
