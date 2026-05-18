import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { join } from "path";
import { existsSync, readFileSync, statSync } from "fs";
import { scenarioRoutes } from "./routes/scenarios";
import { resultRoutes } from "./routes/results";
import { fanoutRoutes } from "./routes/fanout";
import { runRoutes } from "./routes/run";
import { runSetRoutes } from "./routes/run-sets";
import { configRoutes } from "./routes/config";
import { configEffectiveRoutes } from "./routes/config-effective";
import { errorRoutes } from "./routes/errors";
import { ErrorLog } from "../util/error-log";
import { activeRunRoutes } from "./routes/active-runs";
import { getMimeType } from "./mime-types";
import { isSafePath, gauntletPath } from "../paths";
import type { RunBroadcaster } from "./ws";
import type { ActiveRunRegistry } from "./active-runs";
import type { RunSetBroadcaster } from "./run-set-broadcaster";
import type { CancelTokenRegistry } from "./run-cancel";
import type { ShutdownState } from "./shutdown";
import type { AppConfig } from "../config";

export function createApp(
  config: AppConfig,
  uiDir?: string,
  broadcaster?: RunBroadcaster,
  registry?: ActiveRunRegistry,
  setBroadcaster?: RunSetBroadcaster,
  cancelTokens?: CancelTokenRegistry,
  shutdownState?: ShutdownState,
) {
  const app = new Hono();
  app.onError((err, c) => {
    return c.json({
      error: "internal",
      message: err instanceof Error ? err.message : String(err),
    }, 500);
  });

  // Graceful shutdown gate: while the daemon is draining, refuse new POSTs
  // (any new run started here would be orphaned a few seconds later).
  // GETs flow through so existing clients can keep polling status. PRI-1477.
  if (shutdownState) {
    app.use("*", async (c, next) => {
      if (shutdownState.isDraining() && c.req.method !== "GET") {
        return c.json({ error: "shutting_down" }, 503);
      }
      return next();
    });
  }

  // Body-size cap (PRI-1478). Applied at the Hono layer so both Bun and
  // Node runtimes enforce it uniformly. 413 + a structured envelope.
  app.use("*", bodyLimit({
    maxSize: config.maxRequestBodySize,
    onError: (c) => c.json({
      error: "body_too_large",
      message: `request body exceeds cap of ${config.maxRequestBodySize} bytes`,
      cap: config.maxRequestBodySize,
    }, 413),
  }));

  const errorLog = new ErrorLog();
  const projectRoot = config.projectRoot;

  const api = new Hono();
  api.route("/scenarios", scenarioRoutes(projectRoot, errorLog));
  api.route("/results", resultRoutes(gauntletPath(projectRoot, "results"), registry));
  api.route("/fanout", fanoutRoutes(config, undefined, errorLog));
  api.route("/run", runRoutes(config, broadcaster, errorLog, registry, setBroadcaster, cancelTokens));
  api.route("/run-sets", runSetRoutes(gauntletPath(projectRoot), cancelTokens));
  api.route("/config", configRoutes(config));
  api.route("/config/effective", configEffectiveRoutes(config));
  api.route("/errors", errorRoutes(errorLog));
  if (registry) api.route("/runs/active", activeRunRoutes(registry, config.activeRunTargetMaxBytes));

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
