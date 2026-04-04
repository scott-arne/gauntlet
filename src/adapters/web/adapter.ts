import { readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Adapter } from "../adapter";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger } from "../../evidence/logger";

// The forked CDP library is CommonJS JS — use require for bun compatibility
const chrome = require("./lib/chrome-ws-lib");

export interface WebAdapterOptions {
  chrome?: string; // host:port for remote Chrome (e.g. "localhost:9222")
}

export class WebAdapter implements Adapter {
  private remote: boolean;

  constructor(options?: WebAdapterOptions) {
    this.remote = false;
    if (options?.chrome) {
      const [host, port] = options.chrome.split(":");
      process.env.CHROME_WS_HOST = host;
      process.env.CHROME_WS_PORT = port;
      this.remote = true;
    }
  }

  async start(url: string): Promise<void> {
    if (!this.remote) {
      await chrome.startChrome(true); // headless
    }
    await chrome.navigate(0, url);
  }

  async close(): Promise<void> {
    if (!this.remote) {
      await chrome.killChrome();
    }
  }

  toolDefinitions(): ToolDefinition[] {
    return [
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
        description: "Click an element matching the given CSS selector",
        parameters: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector of the element to click",
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
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    logger: EvidenceLogger
  ): Promise<ToolResult> {
    logger.logAction(name, args);

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
        await chrome.click(0, args.selector as string);
        return { text: "clicked", image: await takeReturnScreenshot() };
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
