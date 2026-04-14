import { parseArgs } from "./cli/args";
import { run } from "./cli/run";

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  switch (args.command) {
    case "run":
      await run(
        args.scenarioPath,
        args.cli.target ?? "",
        args.outDir,
        args.adapter,
        {
          agent: args.cli.models?.agent || process.env.GAUNTLET_AGENT_MODEL || "claude-sonnet-4-6",
          fanout: args.cli.models?.fanout || process.env.GAUNTLET_FANOUT_MODEL,
        },
        args.cli.chrome,
      );
      break;
    case "validate": {
      const { validateScenario } = await import("./cli/validate");
      const result = validateScenario(args.scenarioPath);
      if (result.valid) {
        console.log(JSON.stringify({ valid: true }));
      } else {
        console.log(JSON.stringify({ valid: false, errors: result.errors }));
        process.exit(1);
      }
      break;
    }
    case "fanout": {
      const { fanout } = await import("./cli/fanout");
      await fanout(args.scenarioPath, args.outDir, args.models, args.resultDir);
      break;
    }
    case "serve": {
      const { createApp } = await import("./api/server");
      const { RunBroadcaster } = await import("./api/ws");
      const { ActiveRunRegistry } = await import("./api/active-runs");
      const { handleWsOpen } = await import("./api/ws-handlers");
      const { join } = await import("path");
      const dataDir = args.cli.dataDir ?? ".";
      const uiDir = join(import.meta.dir, "..", "ui", "dist");
      const broadcaster = new RunBroadcaster();
      const registry = new ActiveRunRegistry();
      const app = createApp(dataDir, uiDir, broadcaster, registry);
      const port = args.cli.port ?? parseInt(process.env.GAUNTLET_PORT || "4400", 10);
      if (!process.env.GAUNTLET_AGENT_MODEL && !process.env.GAUNTLET_MODELS) {
        console.error("WARNING: No model configured. Set GAUNTLET_AGENT_MODEL or GAUNTLET_MODELS environment variable.");
      }
      console.error(`gauntlet server listening on port ${port}`);
      Bun.serve({
        port,
        idleTimeout: 255, // seconds; LLM calls can take minutes
        fetch(req, server) {
          const url = new URL(req.url);
          if (url.pathname === "/api/ws") {
            const runId = url.searchParams.get("run") || "";
            const upgraded = server.upgrade(req, { data: { runId } });
            if (upgraded) return undefined;
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
          return app.fetch(req);
        },
        websocket: {
          open(ws) {
            const runId = (ws.data as any).runId;
            if (runId) handleWsOpen(registry, broadcaster, runId, ws as any);
          },
          close(ws) {
            const runId = (ws.data as any).runId;
            if (runId) broadcaster.removeClient(runId, ws as any);
          },
          message() {},
        },
      });
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
