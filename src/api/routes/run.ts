import { Hono } from "hono";
import { join } from "path";
import { findCard } from "./helpers";
import { createClient } from "../../models/resolve";
import { EvidenceLogger } from "../../evidence/logger";
import { writeResultFiles } from "../../evidence/writer";
import { runAgent } from "../../agent/agent";
import { renderContextTree } from "../../context/tree";
import { makeRunId, sanitizeProfileSegment } from "../../util/id";
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
  const storiesDir = gauntletPath(config.projectRoot, "stories");
  const contextRoot = gauntletPath(config.projectRoot, "context");

  router.post("/:id", async (c) => {
    const entry = findCard(storiesDir, c.req.param("id"));
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
    const outDir = gauntletPath(config.projectRoot, "results", entry.card.id);
    // Create the logger *before* the adapter so WebAdapter can open its
    // background observer session against it in start().
    const logger = new EvidenceLogger(outDir);
    // Per-run Chrome profile name for browser state isolation (spec
    // §5.1). Generated here so concurrent POSTs against the same card
    // still get distinct profile dirs.
    const runId = makeRunId();
    const chromeProfileName = `gauntlet-run-${runId}-${sanitizeProfileSegment(entry.card.id)}`;
    const adapter = createAdapter(effective.adapter, effective.chrome, contextRoot, logger, chromeProfileName);
    // Render the tree **once per run** — the immutability invariant
    // (spec §4.2) forbids re-rendering during the run.
    const contextTree = renderContextTree(contextRoot);

    const startedAt = Date.now();
    if (registry) {
      registry.register({
        id: entry.card.id,
        title: entry.card.title,
        target: effective.target,
        model: effective.model,
        startedAt,
      });
    }

    // Detach: run the agent in the background. The HTTP request returns now.
    executeRun({
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
      errorLog?.add("run", `${entry.card.id}: ${message}`);
    });

    return c.json({ id: entry.card.id }, 202);
  });

  return router;
}

export interface ExecuteRunOpts {
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
  /** Token used to guard against clobbering a fresh same-card run. */
  startedAt?: number;
  /**
   * Rendered context tree from `renderContextTree`. Built once per run
   * by the route handler and threaded to `runAgent` so the system
   * prompt's Context section can be assembled at turn 0. See spec §4.2.
   */
  contextTree?: string;
}

export async function executeRun(opts: ExecuteRunOpts): Promise<void> {
  const { card, adapter, adapterType, client, target, outDir, logger, broadcaster, registry, errorLog, startedAt, contextTree } = opts;

  if (broadcaster || registry) {
    logger.onAction = (action, params) => {
      const message = `[${action}] ${JSON.stringify(params)}`;
      broadcaster?.send(card.id, {
        type: "progress",
        message,
        status: "running",
        card: card.id,
      });
      registry?.recordProgress(card.id, message);
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
        broadcaster?.send(card.id, {
          type: "frame",
          data: frame.data,
          width: frame.metadata.width,
          height: frame.metadata.height,
        });
        registry?.recordFrame(card.id, {
          data: frame.data,
          width: frame.metadata.width,
          height: frame.metadata.height,
        });
      }, framesDir);
      await streamer.start();
    }

    const result = await runAgent(card, adapter, client, logger, target, {
      contextTree,
    });
    writeResultFiles(outDir, result);

    terminal = { type: "complete", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorLog?.add("run", `${card.id}: ${message}`);
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
    registry?.unregister(card.id, startedAt);
    // Emit the terminal event AFTER unregister so a late-connecting
    // WebSocket sees an empty registry (and receives `gone`) instead of a
    // stale snapshot that would never get a follow-up event.
    if (terminal) broadcaster?.send(card.id, terminal);
  }
}
