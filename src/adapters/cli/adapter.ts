import { mkdirSync } from "fs";
import { join } from "path";
import type { Adapter } from "../adapter";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger } from "../../evidence/logger";
import { buildReadTool, type ReadTool } from "../../context/read-tool";
import { buildFetchCredentialTool, type FetchCredentialTool } from "../../context/credential-tool";
import type { CredentialResolverConfig } from "../../config";
import { validateToolArgs } from "../../agent/validators";
import { spawn, spawnSync, type SpawnedProcess } from "../../runtime/spawn";
import { listDescendants, killProcessTree } from "../../runtime/process-tree";

const KEY_MAP: Record<string, string> = {
  Enter: "\n",
  Tab: "\t",
  Escape: "\x1b",
  "Ctrl+C": "\x03",
  "Ctrl+D": "\x04",
  "Ctrl+Z": "\x1a",
};


export interface CLIAdapterOptions {
  contextRoot?: string;
  /**
   * Per-run directory under which the adapter creates a `scratch/`
   * subdirectory that becomes the shell's cwd. The orchestrator passes
   * the run's `outDir` here. Optional only so the registry's
   * tool-introspection construction (which never starts a shell) still
   * works; in production it is always set.
   */
  runDir?: string;
  /**
   * Logger used by the adapter to emit cleanup events
   * (`cli_shell_descendants_reaped`). Optional for the same registry reason.
   */
  logger?: EvidenceLogger;
  /**
   * Forwarded to the fetch_credential tool — unchanged from the
   * pre-PRI-1608 adapter. Orthogonal to shell-as-session.
   */
  credentialResolver?: CredentialResolverConfig;
}

export class CLIAdapter implements Adapter {
  readonly name = "cli";
  private proc: SpawnedProcess | null = null;
  private pgid: number | null = null;
  private buffer = "";
  private readTool: ReadTool | null;
  private credentialTool: FetchCredentialTool | null;
  /** Lazy cache of tool name → parameter schema for O(1) validation. */
  private toolSchemas: Map<string, ToolDefinition["parameters"]> | null = null;
  private runDir: string | undefined;
  private logger: EvidenceLogger | undefined;

  constructor(options?: CLIAdapterOptions) {
    this.readTool = options?.contextRoot
      ? buildReadTool(options.contextRoot)
      : null;
    this.credentialTool = buildFetchCredentialTool(
      options?.contextRoot ?? "",
      options?.credentialResolver,
    );
    this.runDir = options?.runDir;
    this.logger = options?.logger;
  }

  async start(_target: string): Promise<void> {
    // Target is informational only — see describeTarget. We spawn bash,
    // not the target.
    this.buffer = "";
    if (!this.runDir) {
      throw new Error("CLIAdapter: runDir is required to start a session");
    }
    const scratch = join(this.runDir, "scratch");
    mkdirSync(scratch, { recursive: true });

    this.proc = spawn(
      ["bash", "--norc", "--noprofile", "-i"],
      { cwd: scratch, detached: true },
    );
    this.pgid = this.proc.pid;

    this.readStream(this.proc.stdout);
    this.readStream(this.proc.stderr);
  }

  private readStream(stream: ReadableStream<Uint8Array>): void {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const pump = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) return;
        this.buffer += decoder.decode(value, { stream: true });
        pump();
      });
    };
    pump();
  }

  readOutput(): string {
    const output = this.buffer;
    this.buffer = "";
    return output;
  }

  describeTarget(target: string): string {
    const base =
      `You are at an interactive bash shell. Use \`type\` and \`press\` to ` +
      `issue shell commands and answer any prompts. The shell is your ` +
      `durable session — many commands can run through it during the ` +
      `run. When you are finished, type \`exit\` to close the shell cleanly.`;
    if (!target) return base;
    return (
      `${base} The command you are exercising is \`${target}\`.`
    );
  }

  defaultViewport(): null {
    return null;
  }

  async type(text: string): Promise<void> {
    if (!this.proc) throw new Error("Process not started");
    this.proc.stdin.write(text);
    this.proc.stdin.flush();
  }

  async press(key: string): Promise<void> {
    const mapped = KEY_MAP[key];
    if (!mapped) throw new Error(`Unknown key: ${key}`);
    await this.type(mapped);
  }

  async close(): Promise<void> {
    if (!this.proc || this.pgid === null) return;
    const pgid = this.pgid;
    const bashPid = this.proc.pid;
    const descendants = listDescendants(bashPid);

    const { reaped } = killProcessTree(pgid, descendants);

    if (reaped > 0 && this.logger) {
      this.logger.logEvent("cli_shell_descendants_reaped", {
        pgid,
        descendantCount: descendants.length,
        reapedCount: reaped,
      });
    }

    this.proc = null;
    this.pgid = null;
  }

  isMutatingTool(name: string): boolean {
    return name === "type" || name === "press";
  }

  toolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: "type",
        description: "Type text into the shell stdin (commands and prompt answers)",
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
        description:
          "Press a special key (Enter, Tab, Escape, Ctrl+C, Ctrl+D, Ctrl+Z)",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Key name to press" },
          },
          required: ["key"],
        },
      },
      {
        name: "read_output",
        description:
          "Read and clear the buffered terminal output since last read",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    ];
    if (this.readTool) {
      tools.push(this.readTool.definition);
    }
    if (this.credentialTool) {
      tools.push(this.credentialTool.definition);
    }
    return tools;
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    logger: EvidenceLogger,
  ): Promise<ToolResult> {
    // Validate the LLM's argument shape once, upfront. Same pattern as
    // WebAdapter — see its executeTool for rationale.
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
      case "read_output": {
        return { text: this.readOutput() };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
