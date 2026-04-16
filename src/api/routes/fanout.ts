import { Hono } from "hono";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseStoryCard } from "../../format/story-card";
import { generateFanout, generateFromObservations, generateFromFailure } from "../../fanout/generator";
import { createClient } from "../../models/resolve";
import { gauntletPath } from "../../paths";
import type { LLMClient } from "../../models/provider";
import type { VetResult } from "../../types";
import { findCard } from "../../cards/store";
import type { ErrorLog } from "./errors";

function resolveClient(clientFactory?: () => LLMClient): LLMClient | { error: string } {
  if (clientFactory) return clientFactory();
  const model = process.env.GAUNTLET_FANOUT_MODEL || process.env.GAUNTLET_AGENT_MODEL;
  if (!model) return { error: "no model configured (set GAUNTLET_FANOUT_MODEL or GAUNTLET_AGENT_MODEL)" };
  return createClient(model);
}

function writeCards(storiesDir: string, cardTexts: string[], prefix: string) {
  mkdirSync(storiesDir, { recursive: true });
  return cardTexts.map((text, i) => {
    const card = parseStoryCard(text);
    const letter = String.fromCharCode(97 + i); // a, b, c, ...
    const filename = `${prefix}-${letter}.md`;
    writeFileSync(join(storiesDir, filename), text);
    return { id: card.id, title: card.title, filename };
  });
}

export function fanoutRoutes(projectRoot: string, clientFactory?: () => LLMClient, errorLog?: ErrorLog) {
  const router = new Hono();
  const storiesDir = gauntletPath(projectRoot, "stories");

  router.post("/:id", async (c) => {
    const entry = findCard(projectRoot, c.req.param("id"), errorLog);
    if (!entry) return c.json({ error: "not found" }, 404);

    const clientOrError = resolveClient(clientFactory);
    if ("error" in clientOrError) return c.json({ error: clientOrError.error }, 400);

    try {
      const cardTexts = await generateFanout(entry.card, clientOrError);
      const generated = writeCards(storiesDir, cardTexts, entry.card.id);
      return c.json({ parent: entry.card.id, generated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorLog?.add("fanout", `${entry.card.id}: ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  router.post("/:id/observations", async (c) => {
    const id = c.req.param("id");
    const resultPath = gauntletPath(projectRoot, "results", id, "result.json");
    if (!existsSync(resultPath)) return c.json({ error: "not found" }, 404);

    const result: VetResult = JSON.parse(readFileSync(resultPath, "utf-8"));
    if (result.observations.length === 0) return c.json({ parent: id, generated: [] });

    const clientOrError = resolveClient(clientFactory);
    if ("error" in clientOrError) return c.json({ error: clientOrError.error }, 400);

    try {
      const cardTexts = await generateFromObservations(result, clientOrError);
      const generated = writeCards(storiesDir, cardTexts, `${id}-obs`);
      return c.json({ parent: id, generated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorLog?.add("fanout", `observations for ${id}: ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  router.post("/:id/failure", async (c) => {
    const id = c.req.param("id");
    const resultPath = gauntletPath(projectRoot, "results", id, "result.json");
    if (!existsSync(resultPath)) return c.json({ error: "not found" }, 404);

    const result: VetResult = JSON.parse(readFileSync(resultPath, "utf-8"));
    if (result.status !== "fail") return c.json({ error: "result is not a failure" }, 400);

    const clientOrError = resolveClient(clientFactory);
    if ("error" in clientOrError) return c.json({ error: clientOrError.error }, 400);

    try {
      const cardTexts = await generateFromFailure(result, clientOrError);
      const generated = writeCards(storiesDir, cardTexts, `${id}-fail`);
      return c.json({ parent: id, generated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorLog?.add("fanout", `failure analysis for ${id}: ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  return router;
}
