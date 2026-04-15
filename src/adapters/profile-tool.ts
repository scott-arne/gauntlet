import type { ToolDefinition, ToolResult } from "../models/provider";
import { listProfiles, readProfile } from "../format/profile";

export interface ProfileTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): ToolResult;
}

const TOOL_DESCRIPTION =
  "Read profile information about a named entity. Profiles can contain " +
  "whatever a story needs to act as that entity: username, password, bio, " +
  "ssh key, API token, notes on behavior, etc. Call this when a story " +
  "refers to a profile by name and you need the details to proceed.";

export function buildReadProfileTool(profilesDir: string): ProfileTool | null {
  if (listProfiles(profilesDir).length === 0) return null;

  const definition: ToolDefinition = {
    name: "read_profile",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The profile name to read.",
        },
      },
      required: ["name"],
    },
  };

  const execute = (args: Record<string, unknown>): ToolResult => {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) {
      const available = listProfiles(profilesDir);
      return {
        text: `Error: read_profile requires a "name" argument. Available: ${available.join(", ") || "(none)"}`,
      };
    }
    try {
      return { text: readProfile(profilesDir, name) };
    } catch {
      const available = listProfiles(profilesDir);
      return {
        text: `Error: no profile named "${name}". Available: ${available.join(", ") || "(none)"}`,
      };
    }
  };

  return { definition, execute };
}
