import type { AppConfig } from "../../src/config";

/**
 * Returns a full, valid AppConfig with sensible test defaults. Pass
 * overrides to customize per-test.
 *
 * Extracted from four near-identical local copies (test/api/fanout.test.ts,
 * test/cli/{run,batch,run-one}.test.ts) that had drifted: some omitted
 * fields and reached for `as any`, one used `saveScreencast` instead of
 * the actual field name `defaultSaveScreencast`. Using the real AppConfig
 * type here surfaces field-name drift at compile time instead of hiding
 * it behind a cast. PRI-1640.
 */
export function makeConfig(
  projectRoot: string,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const base: AppConfig = {
    projectRoot,
    port: 4400,
    defaultChrome: { host: "127.0.0.1", port: 9222 },
    defaultBudgetMs: 300_000,
    defaultReflectionInterval: 10,
    defaultViewport: { width: 1440, height: 900 },
    defaultSaveScreencast: false,
    shutdownGraceMs: 10_000,
    maxRequestBodySize: 1024 * 1024,
    maxConcurrentRuns: 4,
    activeRunTargetMaxBytes: 1024,
    wsIdleTimeoutSec: 60,
    wsOriginAllowlist: [],
    models: { agent: "claude-sonnet-4-6", fanout: undefined, available: [] },
    apiKeys: { anthropic: false, openai: false },
    sources: {
      projectRoot: "default",
      port: "default",
      defaultChrome: "default",
      defaultTarget: "unset",
      defaultBudgetMs: "default",
      defaultReflectionInterval: "default",
      defaultViewport: "default",
      defaultSaveScreencast: "default",
      shutdownGraceMs: "default",
      maxRequestBodySize: "default",
      maxConcurrentRuns: "default",
      activeRunTargetMaxBytes: "default",
      wsIdleTimeoutSec: "default",
      wsOriginAllowlist: "default",
      "models.agent": "default",
      "models.fanout": "unset",
      "models.available": "default",
      credentialResolver: "default",
    },
  };
  return { ...base, ...overrides };
}
