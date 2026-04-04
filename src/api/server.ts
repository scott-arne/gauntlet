import { Hono } from "hono";
import { join } from "path";
import { existsSync, readFileSync, statSync } from "fs";
import { scenarioRoutes } from "./routes/scenarios";
import { resultRoutes } from "./routes/results";
import { fanoutRoutes } from "./routes/fanout";
import { runRoutes } from "./routes/run";
import { configRoutes } from "./routes/config";
import { isSafePath } from "./safe-path";
import { getMimeType } from "./mime-types";
import type { RunBroadcaster } from "./ws";

export function createApp(dataDir: string, uiDir?: string, broadcaster?: RunBroadcaster) {
  const app = new Hono();

  const api = new Hono();
  api.route("/scenarios", scenarioRoutes(dataDir));
  api.route("/results", resultRoutes(join(dataDir, "results")));
  api.route("/fanout", fanoutRoutes(dataDir));
  api.route("/run", runRoutes(dataDir, broadcaster));
  api.route("/config", configRoutes());

  app.route("/api", api);

  if (uiDir && existsSync(uiDir)) {
    app.get("*", (c) => {
      const urlPath = new URL(c.req.url).pathname;
      const filePath = join(uiDir, urlPath);

      if (!isSafePath(uiDir, filePath)) {
        return c.notFound();
      }

      try {
        if (existsSync(filePath) && statSync(filePath).isFile()) {
          const content = readFileSync(filePath);
          const ext = filePath.split(".").pop() || "";
          return new Response(content, {
            headers: { "Content-Type": getMimeType(ext) },
          });
        }
      } catch {
        // File disappeared between check and read — fall through to SPA
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
