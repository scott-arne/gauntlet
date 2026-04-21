import { readFileSync, unlinkSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Adapter } from "../adapter";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger, BrowserEventCategory } from "../../evidence/logger";
import type { ChromeEndpoint, Viewport } from "../../config";
import { buildReadTool, type ReadTool } from "../../context/read-tool";
import {
  buildInstallPasskeyTool,
  type PasskeyTool,
  type WebAuthnDriver,
} from "./passkey";
import { validateToolArgs } from "../../agent/validators";

// The forked CDP library is CommonJS JS — use require for bun compatibility
const chrome = require("./lib/chrome-ws-lib");

// Passkey tool acts on tab index 0, matching the rest of this adapter.
const PASSKEY_TAB = 0;

// The default driver opens a dedicated CDP session (pinned WebSocket) for
// WebAuthn. See chrome-ws-lib's webAuthnOpenSession comment for why we
// bypass the connection pool.
const webAuthnDriver: WebAuthnDriver = {
  async openSession(tab) {
    return await chrome.webAuthnOpenSession(tab);
  },
};

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
}

export class WebAdapter implements Adapter {
  private remote: boolean;
  private readTool: ReadTool | null;
  private passkeyTool: PasskeyTool | null;
  private logger: EvidenceLogger | null;
  private observerSession: ObserverSession | null = null;
  private chromeProfileName: string | null;
  private viewport: Viewport | null;
  /** Lazy cache of tool name → parameter schema for O(1) validation. */
  private toolSchemas: Map<string, ToolDefinition["parameters"]> | null = null;

  constructor(options?: WebAdapterOptions) {
    this.remote = false;
    if (options?.chrome) {
      chrome.setEndpoint(options.chrome.host, options.chrome.port);
      this.remote = true;
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
          webAuthnDriver,
          this.logger,
        )
      : null;
  }

  async start(url: string): Promise<void> {
    if (!this.remote) {
      // Pass the per-run profile name (spec §5.1) so each run gets its
      // own --user-data-dir. Falls back to chrome-ws-lib's default when
      // the runner did not provide one (kept for test backwards-compat).
      await chrome.startChrome(true, this.chromeProfileName ?? null); // headless
    }
    await chrome.navigate(0, url);

    // Pin the viewport before the observer opens so any downstream
    // layout/resize events are captured as initial state. Best-effort:
    // a failing viewport override should not fail the run, since the
    // window-size flag already gives us a reasonable default.
    if (this.viewport) {
      try {
        await chrome.setViewport(0, {
          width: this.viewport.width,
          height: this.viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
      } catch (err) {
        this.logger?.logAction("set_viewport_failed", {
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
      await chrome.clearBrowserData(0);
    }

    // Open the observer session *after* navigation so the initial page
    // load and LiveSocket handshake are captured as the first events we see.
    if (this.logger) {
      const logger = this.logger;
      try {
        this.observerSession = await chrome.openObserverSession(
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
        logger.logAction("observer_session_failed", { reason });
      }
    }
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
      await chrome.killChrome();
      // Recursively delete the per-run Chrome profile directory (spec
      // §5.1). Best-effort: failures are logged as an action-log entry
      // but never thrown — a leftover stale dir is preferable to
      // failing the close path. Skipped when no profile name was
      // provided (e.g., legacy/test usage without a runner).
      if (this.chromeProfileName) {
        const dir = chrome.getChromeProfileDir(this.chromeProfileName);
        try {
          await rm(dir, { recursive: true, force: true });
        } catch (err) {
          this.logger?.logAction("chrome_profile_cleanup_failed", {
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
          "Capture the rendered pixels of the page or an element. Use this " +
          "whenever you need to verify visual content — images, icons, " +
          "charts, SVG graphics, canvas output, colors, layout, or " +
          "animation state — since `extract` returns text only and will " +
          "silently miss anything that is not DOM text.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "extract",
        description:
          "Extract the text content of the page or an element. Returns DOM " +
          "text only: images, icons, SVG graphics, canvas output, and CSS " +
          "background content are NOT captured. For anything visual, use " +
          "`screenshot` instead.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
                "Take a screenshot after this action and return the image. " +
                "Set true when the outcome is visual (an image loads, a " +
                "modal appears, a chart renders, the layout shifts) — " +
                "`extract` cannot see non-text content.",
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
    return tools;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    logger: EvidenceLogger
  ): Promise<ToolResult> {
    logger.logAction(name, args);

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

    const takeReturnScreenshot = async (): Promise<ToolResult["image"]> => {
      if (!args.return_screenshot) return undefined;
      const tmpFile = join(tmpdir(), `gauntlet-screenshot-${Date.now()}.png`);
      await chrome.screenshot(0, tmpFile, null, false);
      const data = readFileSync(tmpFile);
      logger.saveScreenshot(Buffer.from(data));
      try { unlinkSync(tmpFile); } catch { }
      return { data: Buffer.from(data).toString("base64"), mediaType: "image/png" };
    };

    switch (name) {
      case "screenshot": {
        const tmpFile = join(
          tmpdir(),
          `gauntlet-screenshot-${Date.now()}.png`
        );
        await chrome.screenshot(
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
        };
      }
      case "click": {
        try {
          const result = await chrome.click(0, args.selector as string);
          const note = result?.fallback
            ? ` (fallback: ${result.fallback})`
            : "";
          return {
            text: `clicked ${args.selector}${note}`,
            image: await takeReturnScreenshot(),
          };
        } catch (err) {
          // Make failures visible to the agent. A silent "clicked" when
          // nothing actually got clicked is a classic way to waste 40
          // turns.
          const reason = err instanceof Error ? err.message : String(err);
          return {
            text: `Error: ${reason}`,
            image: await takeReturnScreenshot(),
          };
        }
      }
      case "type": {
        const selector = args.selector as string | undefined;
        const text = args.text as string;
        if (selector) {
          await chrome.fill(0, selector, text);
        } else {
          // No selector — type via keyboard
          for (const char of text) {
            await chrome.keyboardPress(0, char);
          }
        }
        return { text: "typed", image: await takeReturnScreenshot() };
      }
      case "press": {
        await chrome.keyboardPress(0, args.key as string);
        return { text: "pressed", image: await takeReturnScreenshot() };
      }
      case "hover": {
        try {
          await chrome.hover(0, args.selector as string);
          return { text: `hovered ${args.selector}`, image: await takeReturnScreenshot() };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { text: `Error: ${reason}`, image: await takeReturnScreenshot() };
        }
      }
      case "double_click": {
        try {
          await chrome.doubleClick(0, args.selector as string);
          return { text: `double-clicked ${args.selector}`, image: await takeReturnScreenshot() };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { text: `Error: ${reason}`, image: await takeReturnScreenshot() };
        }
      }
      case "right_click": {
        try {
          await chrome.rightClick(0, args.selector as string);
          return { text: `right-clicked ${args.selector}`, image: await takeReturnScreenshot() };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { text: `Error: ${reason}`, image: await takeReturnScreenshot() };
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
          await chrome.drag(0, sourceSelector, target);
          return { text: `dragged ${sourceSelector}`, image: await takeReturnScreenshot() };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { text: `Error: ${reason}`, image: await takeReturnScreenshot() };
        }
      }
      case "mouse_move": {
        await chrome.mouseMove(0, args.x as number, args.y as number);
        return { text: `moved mouse to (${args.x}, ${args.y})`, image: await takeReturnScreenshot() };
      }
      case "scroll": {
        const direction = args.direction as "up" | "down" | "left" | "right";
        const amount = (args.amount as number) ?? 300;
        // Map direction → wheel delta. Chrome's mouseWheel uses +y=down,
        // +x=right, which matches intuitive direction names.
        const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
        const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
        await chrome.scroll(0, {
          deltaX,
          deltaY,
          selector: (args.selector as string) ?? undefined,
        });
        return { text: `scrolled ${direction} ${amount}px`, image: await takeReturnScreenshot() };
      }
      case "file_upload": {
        try {
          const result = await chrome.fileUpload(
            0,
            args.selector as string,
            args.file_paths as string[],
          );
          return {
            text: `uploaded ${result.files} file(s) to ${args.selector}`,
            image: await takeReturnScreenshot(),
          };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { text: `Error: ${reason}`, image: await takeReturnScreenshot() };
        }
      }
      case "navigate": {
        await chrome.navigate(0, args.url as string);
        return { text: "navigated", image: await takeReturnScreenshot() };
      }
      case "extract": {
        const selector = args.selector as string | undefined;
        if (selector) {
          const text = await chrome.extractText(0, selector);
          return { text };
        }
        const markdown = await chrome.generateMarkdown(0);
        return { text: markdown };
      }
      case "eval": {
        const result = await chrome.evaluate(0, args.expression as string);
        const text = result === undefined ? "undefined" : (typeof result === "string" ? result : JSON.stringify(result));
        return { text, image: await takeReturnScreenshot() };
      }
      case "wait_for": {
        const timeout = (args.timeout as number) ?? 5000;
        if (args.selector) {
          await chrome.waitForElement(0, args.selector as string, timeout);
          return { text: "element found", image: await takeReturnScreenshot() };
        }
        if (args.text) {
          await chrome.waitForText(0, args.text as string, timeout);
          return { text: "text found", image: await takeReturnScreenshot() };
        }
        return { text: "nothing to wait for — provide selector or text" };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
