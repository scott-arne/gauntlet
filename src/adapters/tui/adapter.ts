import type { Adapter } from "../adapter";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger } from "../../evidence/logger";
import { buildReadTool, type ReadTool } from "../../context/read-tool";
import { buildFetchCredentialTool, type FetchCredentialTool } from "../../context/credential-tool";
import { validateToolArgs } from "../../agent/validators";
import type { CredentialResolverConfig, Viewport } from "../../config";
import { defaultCaptureParser, type CaptureParser } from "./capture-parser";
import { spawnSync } from "../../runtime/spawn";
import { mkdirSync } from "fs";
import { join } from "path";
import { listDescendants } from "../../runtime/process-tree";

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
  /**
   * Per-run directory; adapter creates `<runDir>/scratch` as bash cwd.
   * Required at start(); optional only so the registry's
   * tool-introspection construction (which never starts a session) still
   * works. In production, always set.
   */
  runDir?: string;
  /**
   * Logger used by the adapter to emit cleanup events
   * (`tui_session_descendants_reaped`). Optional for the same registry
   * reason.
   */
  logger?: EvidenceLogger;
  credentialResolver?: CredentialResolverConfig;
  /** Override the capture parser (differential testing, future ghostty
   *  selection). Defaults to xterm. */
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
  private runDir: string | undefined;
  private logger: EvidenceLogger | undefined;
  private bashPid: number | null = null;

  constructor(options?: TUIAdapterOptions) {
    this.readTool = options?.contextRoot
      ? buildReadTool(options.contextRoot)
      : null;
    this.credentialTool = buildFetchCredentialTool(
      options?.contextRoot ?? "",
      options?.credentialResolver,
    );
    this.captureParser = options?.captureParser ?? defaultCaptureParser;
    this.runDir = options?.runDir;
    this.logger = options?.logger;
  }

  get sessionName(): string {
    if (!this._sessionName) throw new Error("Session not started");
    return this._sessionName;
  }

  async start(_target: string): Promise<void> {
    if (!this.runDir) {
      throw new Error("TUIAdapter: runDir is required to start a session");
    }
    const id = `gauntlet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._sessionName = id;
    const scratch = join(this.runDir, "scratch");
    mkdirSync(scratch, { recursive: true });

    const create = spawnSync([
      "tmux", "new-session", "-d", "-s", id,
      "-x", String(TUI_GRID.width),
      "-y", String(TUI_GRID.height),
      "-c", scratch,
      "bash", "--norc", "--noprofile", "-i",
    ]);
    if (create.exitCode !== 0) {
      throw new Error(
        `Failed to start tmux session: ${new TextDecoder().decode(create.stderr)}`,
      );
    }

    this.bashPid = await this.readPanePid(id);
  }

  private async readPanePid(sessionId: string): Promise<number> {
    // tmux new-session -d should make pane_pid available immediately, but on
    // loaded CI machines we've seen the first read race the pane setup.
    // One short retry covers the gap cheaply.
    for (let attempt = 0; attempt < 2; attempt++) {
      const pane = spawnSync(["tmux", "list-panes", "-t", sessionId, "-F", "#{pane_pid}"]);
      if (pane.exitCode === 0) {
        const pid = Number(new TextDecoder().decode(pane.stdout).trim());
        if (Number.isFinite(pid) && pid > 0) return pid;
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Failed to read pane pid for session ${sessionId} after retry`);
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
    const base =
      `You are at an interactive bash shell rendered inside a tmux pane ` +
      `(${TUI_GRID.width}×${TUI_GRID.height}). Use \`type\` and \`press\` to ` +
      `issue shell commands and answer any prompts. The shell is your ` +
      `durable session — many commands can run through it during the run. ` +
      `When you are finished, type \`exit\` to close the shell cleanly.`;
    if (!target) return base;
    return `${base} The command you are exercising is \`${target}\`.`;
  }

  defaultViewport(): Viewport {
    return TUI_GRID;
  }

  async close(): Promise<void> {
    if (!this._sessionName) return;
    const sessionName = this._sessionName;
    const descendants = this.bashPid !== null
      ? listDescendants(this.bashPid)
      : [];

    try {
      spawnSync(["tmux", "kill-session", "-t", sessionName]);
    } catch {
      // session may already be dead
    }

    let reaped = 0;
    for (const pid of descendants) {
      try { process.kill(pid, "SIGKILL"); reaped++; } catch { /* already dead */ }
    }
    if (reaped > 0 && this.logger) {
      this.logger.logEvent("tui_session_descendants_reaped", {
        sessionName,
        descendantCount: descendants.length,
        reapedCount: reaped,
      });
    }

    this._sessionName = null;
    this.bashPid = null;
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
