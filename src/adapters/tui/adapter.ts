import type { Adapter } from "../adapter";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger } from "../../evidence/logger";
import { buildReadTool, type ReadTool } from "../../context/read-tool";
import { buildFetchCredentialTool, type FetchCredentialTool } from "../../context/credential-tool";
import { validateToolArgs } from "../../agent/validators";
import type { CredentialResolverConfig, Viewport } from "../../config";
import { defaultCaptureParser, type CaptureParser } from "./capture-parser";
import { spawnSync } from "../../runtime/spawn";

/**
 * tmux pane dimensions in character cells. Hardcoded for now — resize
 * support lands when we have a reason to need it. `defaultViewport()`
 * reports these in the run snapshot.
 */
const TUI_GRID: Viewport = { width: 120, height: 40 };

const KEY_MAP: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
  Backspace: "BSpace",
  Delete: "DC",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  "Ctrl+C": "C-c",
  "Ctrl+D": "C-d",
  "Ctrl+Z": "C-z",
  "Ctrl+X": "C-x",
  "Ctrl+O": "C-o",
  "Ctrl+S": "C-s",
  "Ctrl+W": "C-w",
  "Ctrl+K": "C-k",
  "Ctrl+G": "C-g",
};

const AVAILABLE_KEYS = Object.keys(KEY_MAP).join(", ");

export interface TUIAdapterOptions {
  contextRoot?: string;
  credentialResolver?: CredentialResolverConfig;
  /** Override the capture parser (differential testing, future ghostty
   * selection). Defaults to xterm. */
  captureParser?: CaptureParser;
}

export class TUIAdapter implements Adapter {
  readonly name = "tui";
  private _sessionName: string | null = null;
  private readTool: ReadTool | null;
  private credentialTool: FetchCredentialTool | null;
  private captureParser: CaptureParser;
  /** Lazy cache of tool name → parameter schema for O(1) validation. */
  private toolSchemas: Map<string, ToolDefinition["parameters"]> | null = null;

  constructor(options?: TUIAdapterOptions) {
    this.readTool = options?.contextRoot
      ? buildReadTool(options.contextRoot)
      : null;
    this.credentialTool = buildFetchCredentialTool(
      options?.contextRoot ?? "",
      options?.credentialResolver,
    );
    this.captureParser = options?.captureParser ?? defaultCaptureParser;
  }

  get sessionName(): string {
    if (!this._sessionName) throw new Error("Session not started");
    return this._sessionName;
  }

  async start(command: string): Promise<void> {
    const id = `gauntlet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._sessionName = id;

    const result = spawnSync([
      "tmux",
      "new-session",
      "-d",
      "-s",
      id,
      "-x",
      String(TUI_GRID.width),
      "-y",
      String(TUI_GRID.height),
      command,
    ]);

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to start tmux session: ${stderr}`);
    }
  }

  async readScreen(): Promise<string> {
    const result = spawnSync([
      "tmux",
      "capture-pane",
      "-t",
      this.sessionName,
      "-p",
      "-e",
    ]);

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to capture pane: ${stderr}`);
    }

    return new TextDecoder().decode(result.stdout);
  }

  async type(text: string): Promise<void> {
    const result = spawnSync([
      "tmux",
      "send-keys",
      "-t",
      this.sessionName,
      "-l",
      text,
    ]);

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to send keys: ${stderr}`);
    }
  }

  async press(key: string): Promise<void> {
    const mapped = KEY_MAP[key];
    if (!mapped) throw new Error(`Unknown key: ${key}. Available: ${AVAILABLE_KEYS}`);

    const result = spawnSync([
      "tmux",
      "send-keys",
      "-t",
      this.sessionName,
      mapped,
    ]);

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to send key: ${stderr}`);
    }
  }

  describeTarget(target: string): string {
    return (
      `A terminal application is already running in a tmux session. Its command ` +
      `line was: ${target}. Keystrokes you send go to the running program — ` +
      `do not retype the command.`
    );
  }

  defaultViewport(): Viewport {
    return TUI_GRID;
  }

  async close(): Promise<void> {
    if (!this._sessionName) return;

    try {
      spawnSync(["tmux", "kill-session", "-t", this._sessionName]);
    } catch {
      // session may already be dead
    }
    this._sessionName = null;
  }

  isMutatingTool(name: string): boolean {
    return name === "type" || name === "press";
  }

  toolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: "type",
        description: "Type literal text into the terminal",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to type" },
          },
          required: ["text"],
        },
      },
      {
        name: "press",
        description: `Press a special key. Available keys: ${AVAILABLE_KEYS}`,
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Key name to press" },
          },
          required: ["key"],
        },
      },
      {
        name: "read_screen",
        description: "Read the current terminal screen. Returns the rendered text with ANSI escape sequences preserved so you can see colors and styles — e.g. `\\x1b[31mX\\x1b[0m` means character X is red. Parse these to verify color-dependent behavior. Cursor-movement and clear sequences are already resolved by the terminal.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    ];
    if (this.readTool) {
      tools.push(this.readTool.definition);
    }
    if (this.credentialTool) tools.push(this.credentialTool.definition);
    return tools;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    logger: EvidenceLogger
  ): Promise<ToolResult> {
    // See WebAdapter.executeTool for the rationale: validate the LLM's
    // argument shape once, upfront, before dispatching to a handler that
    // would otherwise `as` the types and crash on bad input.
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

    if (name === "fetch_credential" && this.credentialTool) {
      return this.credentialTool.execute(args, logger);
    }

    switch (name) {
      case "type": {
        await this.type(args.text as string);
        return { text: "typed" };
      }
      case "press": {
        await this.press(args.key as string);
        return { text: "pressed" };
      }
      case "read_screen": {
        const screen = await this.readScreen();
        // Parse on the server so the UI can render a layout-correct
        // 2D grid without re-parsing on every view. Both the raw ANSI
        // and the parsed JSON land under captures/.
        const parsed = await this.captureParser.parse(
          screen,
          TUI_GRID.width,
          TUI_GRID.height,
        );
        const capturePath = logger.saveCapture(screen, JSON.stringify(parsed));
        // Stream a `tui_capture` event over the existing WS channel.
        // Using logEvent (rather than a bespoke broadcaster call) lets
        // the observer plumbing already wired in run.ts forward this to
        // any subscribed clients — one mechanism, not two.
        logger.logEvent("tui_capture", {
          path: capturePath,
          cols: parsed.cols,
          rows: parsed.rows,
        });
        // LLM still sees the full ANSI via `text`; the logger will
        // substitute `capturePath` for `text` when writing the
        // tool_result row to run.jsonl.
        return { text: screen, capturePath };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
