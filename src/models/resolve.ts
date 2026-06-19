import type { LLMClient, Provider } from "./provider";
import type { ModelConfig } from "../types";
import { createAnthropicClient } from "./anthropic";
import { createOpenAIClient } from "./openai";

export const SUPPORTED_MODEL_PREFIXES_MESSAGE =
  "Supported prefixes: claude*, anthropic.claude* / <region>.anthropic.claude* (Bedrock), gpt*, o1*, o3*";

export class UnknownModelProviderError extends Error {
  readonly code = "unknown_model";

  constructor(readonly model: string) {
    super(`Model not supported. ${SUPPORTED_MODEL_PREFIXES_MESSAGE}`);
    this.name = "UnknownModelProviderError";
  }
}

export function createClientForProvider(model: string, provider: Provider): LLMClient {
  switch (provider) {
    case "anthropic":
      return createAnthropicClient(model);
    case "openai":
      return createOpenAIClient(model);
  }
}

export function createClient(model: string): LLMClient {
  return createClientForProvider(model, resolveProvider(model));
}

// Bedrock inference-profile ids carry a regional routing prefix and an
// `anthropic.` vendor segment, e.g. `us.anthropic.claude-sonnet-4-5-...` or the
// region-agnostic `anthropic.claude-...`. They are passed through to the Bedrock
// SDK verbatim (see useBedrock / createAnthropicClient), so resolution must
// recognize the prefixed form here or it would throw before the client is built.
const BEDROCK_ANTHROPIC_RE = /^([a-z]{2,3}\.)?anthropic\.claude/;

export function resolveProvider(model: string): Provider {
  if (model.startsWith("claude") || BEDROCK_ANTHROPIC_RE.test(model)) {
    return "anthropic";
  }
  if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) {
    return "openai";
  }
  throw new UnknownModelProviderError(model);
}

export function parseModelFlags(flags: string[]): Partial<ModelConfig> {
  const config: Partial<ModelConfig> = {};

  for (const flag of flags) {
    const idx = flag.indexOf("=");
    if (idx === -1) continue;
    const role = flag.slice(0, idx) as keyof ModelConfig;
    const model = flag.slice(idx + 1);
    config[role] = model;
  }

  return config;
}
