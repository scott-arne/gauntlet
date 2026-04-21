import type { Adapter } from "../adapter";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger } from "../../evidence/logger";
import { buildReadTool, type ReadTool } from "../../context/read-tool";
import { validateToolArgs } from "../../agent/validators";

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
}

export class TUIAdapter implements Adapter {
  readonly name = "tui";
  private _sessionName: string | null = null;
  private readTool: ReadTool | null;
  /** Lazy cache of tool name → parameter schema for O(1) validation. */
  private toolSchemas: Map<string, ToolDefinition["parameters"]> | null = null;

  constructor(options?: TUIAdapterOptions) {
    this.readTool = options?.contextRoot
      ? buildReadTool(options.contextRoot)
      : null;
  }

  get sessionName(): string {
    if (!this._sessionName) throw new Error("Session not started");
    return this._sessionName;
  }

  async start(command: string): Promise<void> {
    const id = `gauntlet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._sessionName = id;

    const result = Bun.spawnSync([
      "tmux",
      "new-session",
      "-d",
      "-s",
      id,
      "-x",
      "120",
      "-y",
      "40",
      command,
    ]);

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to start tmux session: ${stderr}`);
    }
  }

  async readScreen(): Promise<string> {
    const result = Bun.spawnSync([
      "tmux",
      "capture-pane",
      "-t",
      this.sessionName,
      "-p",
    ]);

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to capture pane: ${stderr}`);
    }

    return new TextDecoder().decode(result.stdout);
  }

  async type(text: string): Promise<void> {
    const result = Bun.spawnSync([
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

    const result = Bun.spawnSync([
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

  async close(): Promise<void> {
    if (!this._sessionName) return;

    try {
      Bun.spawnSync(["tmux", "kill-session", "-t", this._sessionName]);
    } catch {
      // session may already be dead
    }
    this._sessionName = null;
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
        description: "Read the current terminal screen contents. Returns the fully rendered screen (TUI escape codes are interpreted).",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    ];
    if (this.readTool) {
      tools.push(this.readTool.definition);
    }
    return tools;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    logger: EvidenceLogger
  ): Promise<ToolResult> {
    logger.logAction(name, args);

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
        return { text: screen };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
