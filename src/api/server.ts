import { Hono } from "hono";
import { join, resolve } from "path";
import { existsSync, readFileSync, statSync } from "fs";
import { scenarioRoutes } from "./routes/scenarios";
import { resultRoutes } from "./routes/results";
import { fanoutRoutes } from "./routes/fanout";
import { runRoutes } from "./routes/run";
import type { RunBroadcaster } from "./ws";

export function createApp(dataDir: string, uiDir?: string, broadcaster?: RunBroadcaster) {
  const app = new Hono();

  const api = new Hono();
  api.route("/scenarios", scenarioRoutes(dataDir));
  api.route("/results", resultRoutes(join(dataDir, "results")));
  api.route("/fanout", fanoutRoutes(dataDir));
  api.route("/run", runRoutes(dataDir, broadcaster));

  app.route("/api", api);

  if (uiDir && existsSync(uiDir)) {
    app.get("*", (c) => {
      const urlPath = new URL(c.req.url).pathname;
      const filePath = join(uiDir, urlPath);
      const resolvedUi = resolve(uiDir);

      if (!resolve(filePath).startsWith(resolvedUi + "/") && resolve(filePath) !== resolvedUi) {
        return c.notFound();
      }

      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const content = readFileSync(filePath);
        const ext = filePath.split(".").pop() || "";
        const mimeTypes: Record<string, string> = {
          html: "text/html",
          js: "application/javascript",
          css: "text/css",
          json: "application/json",
          png: "image/png",
          jpg: "image/jpeg",
          svg: "image/svg+xml",
          woff2: "font/woff2",
          webm: "video/webm",
          mp4: "video/mp4",
        };
        return new Response(content, {
          headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
        });
      }

      const indexPath = join(uiDir, "index.html");
      if (existsSync(indexPath)) {
        return new Response(readFileSync(indexPath), {
          headers: { "Content-Type": "text/html" },
        });
      }

      return c.notFound();
    });
  }

  return app;
}
