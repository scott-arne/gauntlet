import { parseArgs } from "./cli/args";
import { run } from "./cli/run";
import type { AppConfig, CliArgsInput } from "./config";

/**
 * loadConfig throws on bad env/flag values. Surface those as a clean
 * one-line error and exit, instead of letting Bun's top-level rejection
 * print a full stack trace — particularly important for `gauntlet config`,
 * whose whole purpose is to diagnose config problems.
 */
async function loadConfigOrExit(cli: CliArgsInput): Promise<AppConfig> {
  const { loadConfig } = await import("./config");
  try {
    return loadConfig(cli, process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

/**
 * Sibling to loadConfigOrExit: enforces the "at least one LLM provider
 * configured" gate at dispatch time for `serve` and `run`. Deliberately
 * NOT called from `config`, which must still work in broken environments
 * so the user can see what's missing.
 */
async function requireLlmCapableOrExit(config: AppConfig): Promise<void> {
  const { requireLlmCapable } = await import("./config");
  try {
    requireLlmCapable(config);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  switch (args.command) {
    case "run": {
      const config = await loadConfigOrExit(args.cli);
      await requireLlmCapableOrExit(config);
      await run({
        scenarioPath: args.scenarioPath,
        target: args.cli.target ?? "",
        outDir: args.outDir,
        adapterType: args.adapter,
        config,
        silent: args.silent,
        format: args.format,
        noColor: args.noColor,
      });
      break;
    }
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
      const config = await loadConfigOrExit(args.cli);
      await requireLlmCapableOrExit(config);
      const { fanout } = await import("./cli/fanout");
      // Prefer an explicit fanout model, else fall back to the agent model.
      // The fanout implementation takes a ModelConfig where `agent` is the
      // model it will actually call; `fanout` is kept on the struct for
      // parity with other callers but is functionally redundant here.
      const models = {
        agent: config.models.fanout ?? config.models.agent,
        fanout: config.models.fanout,
      };
      await fanout(args.scenarioPath, args.outDir, models, args.resultDir);
      break;
    }
    case "config": {
      const { runConfigCommand } = await import("./cli/config-command");
      try {
        console.log(runConfigCommand(args, process.env));
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
      break;
    }
    case "serve": {
      const { createApp } = await import("./api/server");
      const { RunBroadcaster } = await import("./api/ws");
      const { ActiveRunRegistry } = await import("./api/active-runs");
      const { handleWsOpen } = await import("./api/ws-handlers");
      const { join } = await import("path");
      const { gauntletPath } = await import("./paths");

      const config = await loadConfigOrExit(args.cli);
      await requireLlmCapableOrExit(config);

      const uiDir = join(import.meta.dir, "..", "ui", "dist");
      const resultsRoot = gauntletPath(config.projectRoot, "results");
      const broadcaster = new RunBroadcaster();
      const registry = new ActiveRunRegistry();
      const app = createApp(config, uiDir, broadcaster, registry);
      const port = config.port;
      console.error(`gauntlet server listening on port ${port}`);
      Bun.serve<{ runId: string }>({
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
            if (runId) handleWsOpen(registry, broadcaster, runId, ws as any, resultsRoot);
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
