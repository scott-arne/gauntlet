import { mkdirSync } from "fs";
import type { ToolDefinition, ToolResult } from "../models/provider";
import type { EvidenceLogger } from "../evidence/logger";
import { spawn } from "../runtime/spawn";

export const BASH_TOOL_DESCRIPTION =
  "The best interface for inspecting logs and files on the host via " +
  "standard Unix tools (rg, tail, grep, cat, wc, find, head, jq, etc.). " +
  "Use this to verify what the system under test actually did or what " +
  "landed on disk — not to drive the SUT itself (use the adapter's " +
  "screen/keyboard tools for that). Each call runs `bash -c <command>` " +
  "in a fresh subprocess; pipes and redirects work; no state persists " +
  "between calls.";

export interface BashToolOptions {
  /** Working directory for every bash call. Created lazily on first call. */
  cwd: string;
}

export interface BashTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, logger: EvidenceLogger): Promise<ToolResult>;
}

export function buildBashTool(opts: BashToolOptions): BashTool {
  const definition: ToolDefinition = {
    name: "bash",
    description: BASH_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to run via `bash -c`.",
        },
      },
      required: ["command"],
    },
  };

  const execute = async (
    args: Record<string, unknown>,
    _logger: EvidenceLogger,
  ): Promise<ToolResult> => {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command) {
      return { text: `Error: bash requires a non-empty "command" argument.` };
    }

    mkdirSync(opts.cwd, { recursive: true });
    const start = Date.now();

    const proc = spawn(["bash", "-c", command], { cwd: opts.cwd });

    const [stdoutResult, stderrResult] = await Promise.all([
      drainStreamCapped(proc.stdout, STDOUT_CAP_BYTES),
      drainStreamCapped(proc.stderr, STDERR_CAP_BYTES),
    ]);
    const code = await proc.exited;
    const elapsedMs = Date.now() - start;

    return {
      text: formatResult({
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        exit_code: code < 0 ? null : code,
        truncated: { stdout: stdoutResult.truncated, stderr: stderrResult.truncated },
        timed_out: false,
        elapsed_ms: elapsedMs,
      }),
    };
  };

  return { definition, execute };
}

const STDOUT_CAP_BYTES = 64 * 1024;
const STDERR_CAP_BYTES = 16 * 1024;

async function drainStreamCapped(
  stream: ReadableStream<Uint8Array>,
  capBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  const chunks: string[] = [];
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (truncated) continue; // keep draining to let the child finish; discard
    if (bytes + value.byteLength > capBytes) {
      const remaining = capBytes - bytes;
      if (remaining > 0) {
        chunks.push(decoder.decode(value.slice(0, remaining), { stream: true }));
        bytes = capBytes;
      }
      truncated = true;
    } else {
      chunks.push(decoder.decode(value, { stream: true }));
      bytes += value.byteLength;
    }
  }
  chunks.push(decoder.decode());
  return { text: chunks.join(""), truncated };
}

interface BashRunResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  truncated: { stdout: boolean; stderr: boolean };
  timed_out: boolean;
  elapsed_ms: number;
}

function formatResult(r: BashRunResult): string {
  const parts: string[] = [];
  parts.push(`exit_code: ${r.exit_code === null ? "null (killed)" : r.exit_code}`);
  parts.push(`elapsed_ms: ${r.elapsed_ms}`);
  if (r.timed_out) parts.push(`timed_out: true`);
  if (r.truncated.stdout) parts.push(`stdout truncated at cap`);
  if (r.truncated.stderr) parts.push(`stderr truncated at cap`);
  parts.push("--- stdout ---");
  parts.push(r.stdout);
  parts.push("--- stderr ---");
  parts.push(r.stderr);
  return parts.join("\n");
}
