import { Hono } from "hono";
import { readdirSync, readFileSync, existsSync, realpathSync } from "fs";
import { join, resolve } from "path";

function isSafePath(base: string, target: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  return resolvedTarget.startsWith(resolvedBase + "/") || resolvedTarget === resolvedBase;
}

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

    if (!isSafePath(resultsDir, resultPath)) {
      return c.json({ error: "invalid path" }, 400);
    }

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

  router.get("/:scenario/video", (c) => {
    const scenario = c.req.param("scenario");
    const scenarioDir = join(resultsDir, scenario);

    if (!isSafePath(resultsDir, scenarioDir)) {
      return c.json({ error: "invalid path" }, 400);
    }

    for (const ext of ["webm", "mp4"]) {
      const videoPath = join(scenarioDir, `video.${ext}`);
      if (existsSync(videoPath)) {
        const content = readFileSync(videoPath);
        return new Response(content, {
          headers: { "Content-Type": `video/${ext}` },
        });
      }
    }

    return c.json({ error: "no video found" }, 404);
  });

  router.get("/:scenario/screenshots/:name", (c) => {
    const scenario = c.req.param("scenario");
    const name = c.req.param("name");
    const filePath = join(resultsDir, scenario, name);

    if (!isSafePath(resultsDir, filePath)) {
      return c.json({ error: "invalid path" }, 400);
    }

    if (!existsSync(filePath)) {
      return c.json({ error: "not found" }, 404);
    }

    const content = readFileSync(filePath);
    const ext = name.split(".").pop() || "png";
    const mimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
    };
    return new Response(content, {
      headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
    });
  });

  return router;
}
