import { Hono } from "hono";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

export function resultRoutes(resultsDir: string) {
  const router = new Hono();

  router.get("/", (c) => {
    if (!existsSync(resultsDir)) {
      return c.json([]);
    }

    const entries = readdirSync(resultsDir, { withFileTypes: true });
    const results: unknown[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(resultsDir, e.name, "result.json");
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, "utf-8");
        results.push(JSON.parse(content));
      } catch {
        // Skip malformed result files
      }
    }

    return c.json(results);
  });

  router.get("/:scenario", (c) => {
    const scenario = c.req.param("scenario");
    const resultPath = join(resultsDir, scenario, "result.json");

    if (!existsSync(resultPath)) {
      return c.json({ error: "not found" }, 404);
    }

    try {
      const content = readFileSync(resultPath, "utf-8");
      return c.json(JSON.parse(content));
    } catch {
      return c.json({ error: "malformed result file" }, 500);
    }
  });

  return router;
}
