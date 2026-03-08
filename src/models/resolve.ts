import type { LLMClient, Provider } from "./provider";
import type { ModelConfig } from "../types";
import { createAnthropicClient } from "./anthropic";
import { createOpenAIClient } from "./openai";

export function createClient(model: string): LLMClient {
  const provider = resolveProvider(model);
  switch (provider) {
    case "anthropic":
      return createAnthropicClient(model);
    case "openai":
      return createOpenAIClient(model);
  }
}

export function resolveProvider(model: string): Provider {
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3"))
    return "openai";
  throw new Error(
    `Cannot determine provider for model "${model}". Expected model name starting with "claude", "gpt", "o1", or "o3".`
  );
}

const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";

export function parseModelFlags(flags: string[]): ModelConfig {
  const config: Partial<ModelConfig> = {};

  for (const flag of flags) {
    const idx = flag.indexOf("=");
    if (idx === -1) continue;
    const role = flag.slice(0, idx) as keyof ModelConfig;
    const model = flag.slice(idx + 1);
    config[role] = model;
  }

  return {
    agent:
      config.agent || process.env.VET_AGENT_MODEL || DEFAULT_AGENT_MODEL,
    fanout: config.fanout || process.env.VET_FANOUT_MODEL,
  };
}
