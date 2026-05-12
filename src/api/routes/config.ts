import { Hono } from "hono";
import type { AppConfig } from "../../config";

/**
 * Lightweight model picker endpoint for the UI. Reads from the resolved
 * AppConfig (which already merges flag > env > default) instead of
 * peeking at process.env directly — otherwise `--model agent=...` on the
 * CLI would not be reflected here.
 */
export function configRoutes(config: AppConfig) {
  const router = new Hono();

  router.get("/", (c) => {
    return c.json({
      models: config.models.available,
      defaultModel: config.models.agent,
      defaultTarget: config.defaultTarget ?? null,
      defaultBudgetMs: config.defaultBudgetMs,
      defaultMaxStuckRetries: config.defaultMaxStuckRetries,
      defaultViewport: config.defaultViewport,
      defaultSaveScreencast: config.defaultSaveScreencast,
    });
  });

  return router;
}
