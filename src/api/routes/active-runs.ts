import { Hono } from "hono";
import type { ActiveRunRegistry } from "../active-runs";

export function activeRunRoutes(registry: ActiveRunRegistry) {
  const router = new Hono();

  router.get("/", (c) => {
    return c.json({ runs: registry.list() });
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
