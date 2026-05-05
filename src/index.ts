#!/usr/bin/env bun
import { parseArgs } from "./cli/args";
import { run } from "./cli/run";
import { formatCliError, isVerboseRequest } from "./cli/error-output";
import type { AppConfig, CliArgsInput } from "./config";

async function loadConfigOrThrow(cli: CliArgsInput): Promise<AppConfig> {
  const { loadConfig } = await import("./config");
  return loadConfig(cli, process.env);
}

/**
 * Sibling to loadConfigOrThrow: enforces the "at least one LLM provider
 * configured" gate at dispatch time for `serve` and `run`. Deliberately
 * NOT called from `config`, which must still work in broken environments
 * so the user can see what's missing.
 */
async function requireLlmCapableOrThrow(config: AppConfig): Promise<void> {
  const { requireLlmCapable } = await import("./config");
  requireLlmCapable(config);
}

async function main() {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case "run": {
      const config = await loadConfigOrThrow(args.cli);
      await requireLlmCapableOrThrow(config);
      await run({
        scenarioPath: args.scenarioPath,
        target: args.cli.target ?? "",
        outDir: args.outDir,
        adapterType: args.adapter,
        config,
        silent: args.silent,
        format: args.format,
        noColor: args.noColor,
        passes: args.passes,
      });
      break;
    }
    case "batch": {
      const config = await loadConfigOrThrow(args.cli);
      await requireLlmCapableOrThrow(config);
      const { runBatch } = await import("./cli/batch");
      const exitCode = await runBatch({
        scenarioPaths: args.scenarioPaths,
        target: args.cli.target ?? "",
        adapterType: args.adapter,
        config,
        silent: args.silent,
        format: args.format,
        noColor: args.noColor,
        sink: { write: (s: string) => process.stdout.write(s) },
        isTTY: Boolean(process.stdout.isTTY),
        passes: args.passes,
      });
      if (exitCode !== 0) process.exit(exitCode);
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
      const config = await loadConfigOrThrow(args.cli);
      await requireLlmCapableOrThrow(config);
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
      console.log(runConfigCommand(args, process.env));
      break;
    }
    case "serve": {
      const { createApp } = await import("./api/server");
      const { RunBroadcaster } = await import("./api/ws");
      const { ActiveRunRegistry } = await import("./api/active-runs");
      const { RunSetBroadcaster } = await import("./api/run-set-broadcaster");
      const { CancelTokenRegistry } = await import("./api/run-cancel");
      const { handleWsOpen, handleSetWsOpen } = await import("./api/ws-handlers");
      const { join } = await import("path");
      const { gauntletPath } = await import("./paths");

      const config = await loadConfigOrThrow(args.cli);
      await requireLlmCapableOrThrow(config);

      const uiDir = join(import.meta.dir, "..", "ui", "dist");
      const gauntletRoot = gauntletPath(config.projectRoot);
      const resultsRoot = gauntletPath(config.projectRoot, "results");
      const broadcaster = new RunBroadcaster();
      const registry = new ActiveRunRegistry();
      const setBroadcaster = new RunSetBroadcaster();
      const cancelTokens = new CancelTokenRegistry();
      const app = createApp(config, uiDir, broadcaster, registry, setBroadcaster, cancelTokens);
      const port = config.port;
      console.error(`gauntlet server listening on port ${port}`);
      Bun.serve<{ runId?: string; runSetId?: string }>({
        port,
        idleTimeout: 255, // seconds; LLM calls can take minutes
        fetch(req, server) {
          const url = new URL(req.url);
          if (url.pathname.startsWith("/api/ws/run-sets/")) {
            const runSetId = url.pathname.slice("/api/ws/run-sets/".length);
            if (!/^[a-z]+_\d{8}T\d{6}Z_[a-z0-9]+$/.test(runSetId)) {
              return new Response("invalid run set id", { status: 400 });
            }
            const upgraded = server.upgrade(req, { data: { runSetId } });
            if (upgraded) return undefined;
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
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
            const data = ws.data as any;
            if (data.runSetId) {
              handleSetWsOpen(setBroadcaster, data.runSetId, ws as any, gauntletRoot);
            } else if (data.runId) {
              handleWsOpen(registry, broadcaster, data.runId, ws as any, resultsRoot);
            }
          },
          close(ws) {
            const data = ws.data as any;
            if (data.runSetId) {
              setBroadcaster.removeClient(data.runSetId, ws as any);
            } else if (data.runId) {
              broadcaster.removeClient(data.runId, ws as any);
            }
          },
          message() {},
        },
      });
      break;
    }
  }
}

main().catch((err) => {
  const verbose = isVerboseRequest(process.env as Record<string, string | undefined>, process.argv);
  process.stderr.write(formatCliError(err, { verbose }));
  process.exit(1);
});
