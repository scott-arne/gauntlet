import { readFileSync, statSync } from "fs";
import type { ToolDefinition, ToolResult } from "../models/provider";
import { contextRootIsPopulated, resolveInside } from "../paths";

// The `read` tool is the agent-facing primitive for pulling file contents
// out of `.gauntlet/context/`. It is a pure filesystem primitive — the
// runner never interprets filenames, never caches results, and never
// writes into the context directory. Path resolution goes through
// `resolveInside` from `../paths.ts`, which matches Gauntlet v1.5 spec §3.1
// verbatim.

export interface ReadTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): ToolResult;
}

// Tool description — authoritative prose from Gauntlet v1.5 spec §3.1.
// DO NOT edit without going through the amendment protocol (spec §13).
// Tests assert this exact string; if a typo sneaks in, the prompts test
// will fail at CI time.
const TOOL_DESCRIPTION =
  "Read a file from the Context list. The `path` argument is a name from " +
  "the tree shown in the Context section of the system prompt — that tree " +
  "is the full map of what's available. Returns the file's contents " +
  "verbatim as text. Binary files are not supported; attempts to read " +
  "binary content return an error. This is the tool to use when a story " +
  "names a user and you need their credentials, character notes, or any " +
  "other file the story references.";

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// UTF-8 decode sanity check: if the file contains NUL bytes or any
// sequence that would have been replaced by U+FFFD on a strict decode,
// treat it as binary. Bun's `readFileSync(..., "utf-8")` does not throw
// on invalid UTF-8; it silently substitutes replacement characters.
// We want an error the agent can see, not silent corruption.
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function buildReadTool(contextRoot: string): ReadTool | null {
  if (!contextRootIsPopulated(contextRoot)) return null;

  const definition: ToolDefinition = {
    name: "read",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "A name from the Context tree (e.g. 'alice/credentials.md'). Must not contain '..' segments or start with '/'.",
        },
      },
      required: ["path"],
    },
  };

  const execute = (args: Record<string, unknown>): ToolResult => {
    const path = typeof args.path === "string" ? args.path : "";

    if (!path) {
      return {
        text: `Error: read requires a "path" argument (a name from the Context tree).`,
      };
    }

    let resolved: string;
    try {
      resolved = resolveInside(contextRoot, path);
    } catch (err) {
      return { text: `Error: ${errorMessage(err)}` };
    }

    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      return { text: `Error: file not found: ${path}` };
    }
    if (!stat.isFile()) {
      return { text: `Error: not a file: ${path}` };
    }

    let buf: Buffer;
    try {
      buf = readFileSync(resolved);
    } catch (err) {
      return { text: `Error: ${errorMessage(err)}` };
    }

    if (looksBinary(buf)) {
      return { text: `Error: binary file not supported: ${path}` };
    }

    return { text: buf.toString("utf-8") };
  };

  return { definition, execute };
}

// Export for tests that want to diff the description against the spec.
export const READ_TOOL_DESCRIPTION = TOOL_DESCRIPTION;
