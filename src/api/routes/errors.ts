import { Hono } from "hono";
import type { ErrorLog } from "../../util/error-log";

export function errorRoutes(log: ErrorLog) {
  const router = new Hono();

  router.get("/", (c) => {
    return c.json({ errors: log.entries() });
  });

  return router;
}
