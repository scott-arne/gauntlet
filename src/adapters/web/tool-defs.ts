import type { ToolDefinition } from "../../models/provider";

/**
 * Static web-adapter tool schema list.
 *
 * Pure data: no runtime state, no chrome/logger reference. The
 * adapter assembles its full toolDefinitions() result by concatenating
 * this with the passkey definition, cookies definition, and the
 * shared-tools array — those three depend on construction-time wiring
 * (contextRoot, credentialResolver) and are appended at the call site.
 *
 * Note: `eval` is intentionally omitted (PRI-1590 experiment). The
 * adapter's executor still implements it, so re-enabling is a one-line
 * addition here, but keeping it out of the schema removes its pull on
 * the agent toward developer-pattern escapes (form.submit(), raw
 * fetch, etc.).
 */
export function webToolDefinitions(): ToolDefinition[] {
  return [
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
    // executor still implements it so re-enabling is one line, but
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
}
