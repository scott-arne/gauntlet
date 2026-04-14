import { Hono } from "hono";
import { join } from "path";
import { findCard } from "./helpers";
import { createClient } from "../../models/resolve";
import { EvidenceLogger } from "../../evidence/logger";
import { writeResultFiles } from "../../evidence/writer";
import { runAgent } from "../../agent/agent";
import type { Adapter } from "../../adapters/adapter";
import type { RunBroadcaster } from "../ws";
import type { ActiveRunRegistry } from "../active-runs";
import type { ScreencastStreamer as ScreencastStreamerType } from "../../streaming/screencast";
import type { ErrorLog } from "./errors";
import type { StoryCard } from "../../format/story-card";
import type { LLMClient } from "../../models/provider";

function createAdapter(type: string, chromeEndpoint?: string): Adapter {
  switch (type) {
    case "cli": {
      const { CLIAdapter } = require("../../adapters/cli/adapter");
      return new CLIAdapter();
    }
    case "tui": {
      const { TUIAdapter } = require("../../adapters/tui/adapter");
      return new TUIAdapter();
    }
    case "web": {
      const { WebAdapter } = require("../../adapters/web/adapter");
      return new WebAdapter({ chrome: chromeEndpoint });
    }
    default:
      throw new Error(`Unknown adapter type: ${type}`);
  }
}

export function runRoutes(
  dataDir: string,
  broadcaster?: RunBroadcaster,
  errorLog?: ErrorLog,
  registry?: ActiveRunRegistry,
) {
  const router = new Hono();
  const storiesDir = join(dataDir, "stories");

  router.post("/:id", async (c) => {
    const entry = findCard(storiesDir, c.req.param("id"));
    if (!entry) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const target = body.target as string | undefined;
    if (!target) return c.json({ error: "target is required" }, 400);

    const adapterType = (body.adapter as string) || "web";
    const model = (body.model as string) || process.env.GAUNTLET_AGENT_MODEL;
    if (!model) {
      return c.json({ error: "no model configured (set GAUNTLET_AGENT_MODEL or pass model in body)" }, 400);
    }

    const client = createClient(model);
    const adapter = createAdapter(adapterType, body.chrome);
    const outDir = join(dataDir, "results", entry.card.id);

    if (registry) {
      registry.register({
        id: entry.card.id,
        title: entry.card.title,
        target,
        model,
        startedAt: Date.now(),
      });
    }

    // Detach: run the agent in the background. The HTTP request returns now.
    executeRun({
      card: entry.card,
      adapter,
      adapterType,
      client,
      target,
      outDir,
      broadcaster,
      registry,
      errorLog,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      errorLog?.add("run", `${entry.card.id}: ${message}`);
    });

    return c.json({ id: entry.card.id }, 202);
  });

  return router;
}

interface ExecuteRunOpts {
  card: StoryCard;
  adapter: Adapter;
  adapterType: string;
  client: LLMClient;
  target: string;
  outDir: string;
  broadcaster?: RunBroadcaster;
  registry?: ActiveRunRegistry;
  errorLog?: ErrorLog;
}

async function executeRun(opts: ExecuteRunOpts): Promise<void> {
  const { card, adapter, adapterType, client, target, outDir, broadcaster, registry, errorLog } = opts;
  const logger = new EvidenceLogger(outDir);

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

    const result = await runAgent(card, adapter, client, logger, target);
    writeResultFiles(outDir, result);

    broadcaster?.send(card.id, { type: "complete", result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorLog?.add("run", `${card.id}: ${message}`);
    broadcaster?.send(card.id, { type: "error", message });
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
    registry?.unregister(card.id);
  }
}
