import { Hono } from "hono";
import { join } from "path";
import { findCard } from "./helpers";
import { createClient } from "../../models/resolve";
import { EvidenceLogger } from "../../evidence/logger";
import { writeResultFiles } from "../../evidence/writer";
import { runAgent } from "../../agent/agent";
import type { Adapter } from "../../adapters/adapter";
import type { RunBroadcaster } from "../ws";

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

export function runRoutes(dataDir: string, broadcaster?: RunBroadcaster) {
  const router = new Hono();
  const storiesDir = join(dataDir, "stories");

  router.post("/:id", async (c) => {
    const entry = findCard(storiesDir, c.req.param("id"));
    if (!entry) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const target = body.target as string | undefined;
    if (!target) return c.json({ error: "target is required" }, 400);

    const adapterType = (body.adapter as string) || "web";
    const model = (body.model as string) || process.env.VET_AGENT_MODEL;
    if (!model) return c.json({ error: "no model configured (set VET_AGENT_MODEL or pass model in body)" }, 400);

    const client = createClient(model);
    const outDir = join(dataDir, "results", entry.card.id);
    const logger = new EvidenceLogger(outDir);
    const adapter = createAdapter(adapterType, body.chrome);

    try {
      await adapter.start(target);
      const result = await runAgent(entry.card, adapter, client, logger, target);
      writeResultFiles(outDir, result);
      return c.json(result);
    } finally {
      await adapter.close();
    }
  });

  return router;
}
