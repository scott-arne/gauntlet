import { Hono } from "hono";
import type { ActiveRunRegistry, ActiveRunInfo } from "../active-runs";

export function activeRunRoutes(registry: ActiveRunRegistry, targetMaxBytes?: number) {
  const router = new Hono();

  router.get("/", (c) => {
    const cap = targetMaxBytes;
    const runs = cap === undefined ? registry.list() : registry.list().map((r) => truncateTarget(r, cap));
    return c.json({ runs });
  });

  // `:runId` is the registry key (see ActiveRunRegistry). Cards no
  // longer have a single canonical run, so callers must use the runId.
  router.get("/:runId/snapshot", (c) => {
    const snap = registry.getSnapshot(c.req.param("runId"));
    if (!snap) return c.json({ error: "not running" }, 404);
    return c.json(snap);
  });

  return router;
}

/**
 * Truncate `target` to `cap` bytes, appending `...` so the truncation is
 * visible. Long targets (e.g. data URIs accidentally pasted into the
 * field) would otherwise blow up the JSON payload — this list endpoint
 * is polled every few seconds by the UI. Per-run snapshot endpoint still
 * returns the full target. PRI-1478.
 */
function truncateTarget(info: ActiveRunInfo, cap: number): ActiveRunInfo {
  if (info.target.length <= cap) return info;
  return { ...info, target: info.target.slice(0, cap) + "..." };
}
