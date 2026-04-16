import type { ToolDefinition, ToolResult } from "../models/provider";
import type { EvidenceLogger } from "../evidence/logger";

export const ADAPTER_TYPES = ["web", "cli", "tui"] as const;
export type AdapterType = typeof ADAPTER_TYPES[number];

export function isAdapterType(s: unknown): s is AdapterType {
  return typeof s === "string" && (ADAPTER_TYPES as readonly string[]).includes(s);
}

export interface Adapter {
  start(target: string): Promise<void>;
  close(): Promise<void>;
  toolDefinitions(): ToolDefinition[];
  executeTool(
    name: string,
    args: Record<string, unknown>,
    logger: EvidenceLogger
  ): Promise<ToolResult>;
}
