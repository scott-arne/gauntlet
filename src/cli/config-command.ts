import type { ConfigArgs } from "./args";
import { loadConfig, type AppConfig } from "../config";

interface ConfigOutput {
  gauntlet: {
    projectRoot: string;
    stateDirName: string;
    port: number;
    defaultChrome: { host: string; port: number };
    defaultTarget: string | null;
    defaultBudgetMs: number;
    defaultReflectionInterval: number;
    defaultViewport: { width: number; height: number };
    defaultSaveScreencast: boolean;
    shutdownGraceMs: number;
    maxRequestBodySize: number;
    maxConcurrentRuns: number;
    activeRunTargetMaxBytes: number;
    wsIdleTimeoutSec: number;
    wsOriginAllowlist: string[];
    models: {
      agent: string;
      fanout: string | null;
      available: string[];
    };
    apiKeys: { anthropic: "set" | "unset"; openai: "set" | "unset"; bedrock: "on" | "off" };
    sources: Record<string, string>;
  };
  sdkEnv: {
    ANTHROPIC_API_KEY: "set" | "unset";
    ANTHROPIC_BASE_URL: string | null;
    ANTHROPIC_LOG: string | null;
    OPENAI_API_KEY: "set" | "unset";
    OPENAI_BASE_URL: string | null;
    OPENAI_ORG_ID: string | null;
    OPENAI_PROJECT: string | null;
    HTTPS_PROXY: string | null;
    HTTP_PROXY: string | null;
    NO_PROXY: string | null;
  };
}

export function buildConfigOutput(config: AppConfig, env: NodeJS.ProcessEnv): ConfigOutput {
  return {
    gauntlet: {
      projectRoot: config.projectRoot,
      stateDirName: config.stateDirName,
      port: config.port,
      defaultChrome: config.defaultChrome,
      defaultTarget: config.defaultTarget ?? null,
      defaultBudgetMs: config.defaultBudgetMs,
      defaultReflectionInterval: config.defaultReflectionInterval,
      defaultViewport: config.defaultViewport,
      defaultSaveScreencast: config.defaultSaveScreencast,
      shutdownGraceMs: config.shutdownGraceMs,
      maxRequestBodySize: config.maxRequestBodySize,
      maxConcurrentRuns: config.maxConcurrentRuns,
      activeRunTargetMaxBytes: config.activeRunTargetMaxBytes,
      wsIdleTimeoutSec: config.wsIdleTimeoutSec,
      wsOriginAllowlist: config.wsOriginAllowlist,
      models: {
        agent: config.models.agent,
        fanout: config.models.fanout ?? null,
        available: config.models.available,
      },
      apiKeys: {
        anthropic: config.apiKeys.anthropic ? "set" : "unset",
        openai: config.apiKeys.openai ? "set" : "unset",
        bedrock: config.apiKeys.bedrock ? "on" : "off",
      },
      sources: config.sources,
    },
    sdkEnv: {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ? "set" : "unset",
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL ?? null,
      ANTHROPIC_LOG: env.ANTHROPIC_LOG ?? null,
      OPENAI_API_KEY: env.OPENAI_API_KEY ? "set" : "unset",
      OPENAI_BASE_URL: env.OPENAI_BASE_URL ?? null,
      OPENAI_ORG_ID: env.OPENAI_ORG_ID ?? null,
      OPENAI_PROJECT: env.OPENAI_PROJECT ?? null,
      HTTPS_PROXY: env.HTTPS_PROXY ?? null,
      HTTP_PROXY: env.HTTP_PROXY ?? null,
      NO_PROXY: env.NO_PROXY ?? null,
    },
  };
}

export function formatConfigText(output: ConfigOutput): string {
  const lines: string[] = [];
  lines.push("# Gauntlet configuration");
  lines.push("");
  lines.push(`  projectRoot:    ${output.gauntlet.projectRoot}  (${output.gauntlet.sources.projectRoot})`);
  lines.push(`  stateDirName:   ${output.gauntlet.stateDirName}  (${output.gauntlet.sources.stateDirName})`);
  lines.push(`  port:           ${output.gauntlet.port}  (${output.gauntlet.sources.port})`);
  lines.push(`  defaultChrome:  ${output.gauntlet.defaultChrome.host}:${output.gauntlet.defaultChrome.port}  (${output.gauntlet.sources.defaultChrome})`);
  lines.push(`  defaultTarget:  ${output.gauntlet.defaultTarget ?? "(unset)"}  (${output.gauntlet.sources.defaultTarget})`);
  lines.push(`  defaultBudgetMs: ${output.gauntlet.defaultBudgetMs}  (${output.gauntlet.sources.defaultBudgetMs})`);
  lines.push(`  defaultReflectionInterval: ${output.gauntlet.defaultReflectionInterval}  (${output.gauntlet.sources.defaultReflectionInterval})`);
  lines.push(`  defaultViewport: ${output.gauntlet.defaultViewport.width}x${output.gauntlet.defaultViewport.height}  (${output.gauntlet.sources.defaultViewport})`);
  lines.push(`  defaultSaveScreencast: ${output.gauntlet.defaultSaveScreencast}  (${output.gauntlet.sources.defaultSaveScreencast})`);
  lines.push(`  shutdownGraceMs: ${output.gauntlet.shutdownGraceMs}  (${output.gauntlet.sources.shutdownGraceMs})`);
  lines.push(`  maxRequestBodySize: ${output.gauntlet.maxRequestBodySize}  (${output.gauntlet.sources.maxRequestBodySize})`);
  lines.push(`  maxConcurrentRuns: ${output.gauntlet.maxConcurrentRuns}  (${output.gauntlet.sources.maxConcurrentRuns})`);
  lines.push(`  activeRunTargetMaxBytes: ${output.gauntlet.activeRunTargetMaxBytes}  (${output.gauntlet.sources.activeRunTargetMaxBytes})`);
  lines.push(`  wsIdleTimeoutSec: ${output.gauntlet.wsIdleTimeoutSec}  (${output.gauntlet.sources.wsIdleTimeoutSec})`);
  lines.push(`  wsOriginAllowlist: [${output.gauntlet.wsOriginAllowlist.join(", ")}]  (${output.gauntlet.sources.wsOriginAllowlist})`);
  lines.push(`  models.agent:   ${output.gauntlet.models.agent}  (${output.gauntlet.sources["models.agent"]})`);
  lines.push(`  models.fanout:  ${output.gauntlet.models.fanout ?? "(unset)"}  (${output.gauntlet.sources["models.fanout"]})`);
  lines.push(`  models.available: [${output.gauntlet.models.available.join(", ")}]  (${output.gauntlet.sources["models.available"]})`);
  lines.push("");
  lines.push("# API keys");
  lines.push(`  anthropic:      ${output.gauntlet.apiKeys.anthropic}`);
  lines.push(`  openai:         ${output.gauntlet.apiKeys.openai}`);
  lines.push(`  bedrock:        ${output.gauntlet.apiKeys.bedrock}`);
  lines.push("");
  lines.push("# SDK-visible environment variables (pass through to SDKs, not read by Gauntlet)");
  for (const [k, v] of Object.entries(output.sdkEnv)) {
    lines.push(`  ${k.padEnd(22)}${v === null ? "(unset)" : v}`);
  }
  return lines.join("\n");
}

export function runConfigCommand(args: ConfigArgs, env: NodeJS.ProcessEnv): string {
  const config = loadConfig(args.cli, env);
  const output = buildConfigOutput(config, env);
  return args.json ? JSON.stringify(output, null, 2) : formatConfigText(output);
}
