import type { Adapter } from "../adapter";
import type { ToolDefinition, ToolResult } from "../../models/provider";
import type { EvidenceLogger } from "../../evidence/logger";
import { buildReadProfileTool, type ProfileTool } from "../profile-tool";


const KEY_MAP: Record<string, string> = {
  Enter: "\n",
  Tab: "\t",
  Escape: "\x1b",
  "Ctrl+C": "\x03",
  "Ctrl+D": "\x04",
  "Ctrl+Z": "\x1a",
};

export interface CLIAdapterOptions {
  profilesDir?: string;
}

export class CLIAdapter implements Adapter {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private buffer = "";
  private profileTool: ProfileTool | null;

  constructor(options?: CLIAdapterOptions) {
    this.profileTool = options?.profilesDir
      ? buildReadProfileTool(options.profilesDir)
      : null;
  }

  async start(command: string): Promise<void> {
    this.buffer = "";
    this.proc = Bun.spawn(["sh", "-c", command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

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
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      // already exited
    }
    this.proc = null;
  }

  toolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: "type",
        description: "Type text into the terminal stdin",
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
    if (this.profileTool) {
      tools.push(this.profileTool.definition);
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
