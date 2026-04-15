import { readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Adapter } from "../adapter";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger, BrowserEventCategory } from "../../evidence/logger";
import type { ChromeEndpoint } from "../../config";
import { buildReadProfileTool, type ProfileTool } from "../profile-tool";
import {
  buildInstallPasskeyTool,
  type PasskeyTool,
  type WebAuthnDriver,
} from "../passkey-tool";

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
  profilesDir?: string;
  /**
   * Optional evidence logger. When provided, the adapter opens a background
   * observer session on start() and streams browser console messages,
   * uncaught exceptions, browser log entries, and WebSocket lifecycle
   * events to the logger as per-category JSONL files in the run's evidence
   * directory. When omitted, no background logging happens.
   */
  logger?: EvidenceLogger;
}

export class WebAdapter implements Adapter {
  private remote: boolean;
  private profileTool: ProfileTool | null;
  private passkeyTool: PasskeyTool | null;
  private logger: EvidenceLogger | null;
  private observerSession: ObserverSession | null = null;

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
    this.profileTool = options?.profilesDir
      ? buildReadProfileTool(options.profilesDir)
      : null;
    this.passkeyTool = options?.profilesDir
      ? buildInstallPasskeyTool(
          options.profilesDir,
          PASSKEY_TAB,
          webAuthnDriver,
          this.logger,
        )
      : null;
  }

  async start(url: string): Promise<void> {
    if (!this.remote) {
      await chrome.startChrome(true); // headless
    }
    await chrome.navigate(0, url);

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
    }
  }

  toolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: "screenshot",
        description: "Take a screenshot of the current page or a specific element",
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
              description: "Take a screenshot after this action and return the image",
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
              description: "Take a screenshot after this action and return the image",
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
              description: "Take a screenshot after this action and return the image",
            },
          },
          required: ["key"],
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
              description: "Take a screenshot after this action and return the image",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "extract",
        description:
          "Extract text content from the page or a specific element",
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
              description: "Take a screenshot after this action and return the image",
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
              description: "Take a screenshot after this action and return the image",
            },
          },
        },
      },
    ];
    if (this.profileTool) {
      tools.push(this.profileTool.definition);
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

    if (name === "read_profile" && this.profileTool) {
      return this.profileTool.execute(args);
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
