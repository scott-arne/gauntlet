import { Hono } from "hono";
import { join } from "path";
import { findCard } from "../../cards/store";
import { createClient } from "../../models/resolve";
import { EvidenceLogger } from "../../evidence/logger";
import { writeResultFiles } from "../../evidence/writer";
import { runAgent } from "../../agent/agent";
import { renderContextTree } from "../../context/tree";
import { makeRunId } from "../../util/id";
import { gauntletPath } from "../../paths";
import { mergeRunConfig, validateRunBody, type AppConfig, type ChromeEndpoint } from "../../config";
import type { Adapter } from "../../adapters/adapter";
import type { RunBroadcaster } from "../ws";
import type { ActiveRunRegistry } from "../active-runs";
import type { ScreencastStreamer as ScreencastStreamerType } from "../../streaming/screencast";
import type { ErrorLog } from "./errors";
import type { StoryCard } from "../../format/story-card";
import type { LLMClient } from "../../models/provider";

function createAdapter(
  type: string,
  chrome: ChromeEndpoint | undefined,
  contextRoot: string,
  logger: EvidenceLogger,
  chromeProfileName: string | undefined,
): Adapter {
  switch (type) {
    case "cli": {
      const { CLIAdapter } = require("../../adapters/cli/adapter");
      return new CLIAdapter({ contextRoot });
    }
    case "tui": {
      const { TUIAdapter } = require("../../adapters/tui/adapter");
      return new TUIAdapter({ contextRoot });
    }
    case "web": {
      const { WebAdapter } = require("../../adapters/web/adapter");
      return new WebAdapter({ chrome, contextRoot, logger, chromeProfileName });
    }
    default:
      throw new Error(`Unknown adapter type: ${type}`);
  }
}

export function runRoutes(
  config: AppConfig,
  broadcaster?: RunBroadcaster,
  errorLog?: ErrorLog,
  registry?: ActiveRunRegistry,
) {
  const router = new Hono();
  const contextRoot = gauntletPath(config.projectRoot, "context");

  router.post("/:id", async (c) => {
    const entry = findCard(config.projectRoot, c.req.param("id"), errorLog);
    if (!entry) return c.json({ error: "not found" }, 404);

    const rawBody = await c.req.json().catch(() => ({}));
    let body;
    try {
      body = validateRunBody(rawBody);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    let effective;
    try {
      effective = mergeRunConfig(config, body);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    if (config.models.available.length > 0 && !config.models.available.includes(effective.model)) {
      return c.json({ error: `model "${effective.model}" is not in GAUNTLET_MODELS allow-list` }, 400);
    }

    const client = createClient(effective.model);
    // runId is the primary key for the run end to end: results dir,
    // active-runs registry, WS broadcaster channel, and the runId field
    // written into result.json. The cardId is preserved as payload
    // metadata where it matters (the registry, the result manifest).
    const runId = makeRunId(entry.card.id);
    const outDir = gauntletPath(config.projectRoot, "results", runId);
    // Create the logger *before* the adapter so WebAdapter can open its
    // background observer session against it in start().
    const logger = new EvidenceLogger(outDir);
    // Per-run Chrome profile name for browser state isolation (spec
    // §5.1). The cardId is already encoded in runId, so no additional
    // suffix is needed.
    const chromeProfileName = `gauntlet-run-${runId}`;
    const adapter = createAdapter(effective.adapter, effective.chrome, contextRoot, logger, chromeProfileName);
    // Render the tree **once per run** — the immutability invariant
    // (spec §4.2) forbids re-rendering during the run.
    const contextTree = renderContextTree(contextRoot);

    const startedAt = Date.now();
    if (registry) {
      registry.register({
        id: runId,
        cardId: entry.card.id,
        title: entry.card.title,
        target: effective.target,
        model: effective.model,
        startedAt,
      });
    }

    // Detach: run the agent in the background. The HTTP request returns now.
    executeRun({
      runId,
      card: entry.card,
      adapter,
      adapterType: effective.adapter,
      client,
      target: effective.target,
      outDir,
      logger,
      broadcaster,
      registry,
      errorLog,
      startedAt,
      contextTree,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      errorLog?.add("run", `${runId}: ${message}`);
    });

    // Callers (e.g. the UI) need runId to subscribe to the WS channel
    // and to look up results on disk. cardId is included so a caller
    // that previously keyed by it still has the value at hand.
    return c.json({ runId, cardId: entry.card.id }, 202);
  });

  return router;
}

export interface ExecuteRunOpts {
  /**
   * Primary identity for the run. Threads through the broadcaster
   * channel, the registry key, and the runId field stamped into the
   * written result. Optional only so legacy test fixtures can omit it;
   * production routes always provide one via `makeRunId(card.id)`.
   */
  runId?: string;
  card: StoryCard;
  adapter: Adapter;
  adapterType: string;
  client: LLMClient;
  target: string;
  outDir: string;
  logger: EvidenceLogger;
  broadcaster?: RunBroadcaster;
  registry?: ActiveRunRegistry;
  errorLog?: ErrorLog;
  /** Token used to guard against clobbering a freshly-registered entry
   * with the same key. */
  startedAt?: number;
  /**
   * Rendered context tree from `renderContextTree`. Built once per run
   * by the route handler and threaded to `runAgent` so the system
   * prompt's Context section can be assembled at turn 0. See spec §4.2.
   */
  contextTree?: string;
}

export async function executeRun(opts: ExecuteRunOpts): Promise<void> {
  const { runId: optsRunId, card, adapter, adapterType, client, target, outDir, logger, broadcaster, registry, errorLog, startedAt, contextTree } = opts;
  // Routing key for the broadcaster and registry. Defaults to cardId so
  // ad-hoc test fixtures continue to work without supplying a runId.
  const runId = optsRunId ?? card.id;

  if (broadcaster || registry) {
    logger.onAction = (action, params) => {
      const message = `[${action}] ${JSON.stringify(params)}`;
      broadcaster?.send(runId, {
        type: "progress",
        message,
        status: "running",
        card: card.id,
      });
      registry?.recordProgress(runId, message);
    };
  }

  let streamer: ScreencastStreamerType | undefined;
  let terminal: Record<string, unknown> | null = null;

  try {
    await adapter.start(target);

    if (adapterType === "web" && (broadcaster || registry)) {
      const { ScreencastStreamer } = await import("../../streaming/screencast");
      const framesDir = join(outDir, "frames");
      streamer = new ScreencastStreamer(0, (frame) => {
        broadcaster?.send(runId, {
          type: "frame",
          data: frame.data,
          width: frame.metadata.width,
          height: frame.metadata.height,
        });
        registry?.recordFrame(runId, {
          data: frame.data,
          width: frame.metadata.width,
          height: frame.metadata.height,
        });
      }, framesDir);
      await streamer.start();
    }

    const result = await runAgent(card, adapter, client, logger, target, {
      contextTree,
      runId,
    });
    writeResultFiles(outDir, result);

    terminal = { type: "complete", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorLog?.add("run", `${runId}: ${message}`);
    terminal = { type: "error", message };
  } finally {
    if (streamer) {
      try {
        await streamer.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      await adapter.close();
    } catch {
      /* ignore */
    }
    registry?.unregister(runId, startedAt);
    // Emit the terminal event AFTER unregister so a late-connecting
    // WebSocket sees an empty registry (and receives `gone`) instead of a
    // stale snapshot that would never get a follow-up event.
    if (terminal) broadcaster?.send(runId, terminal);
  }
}
