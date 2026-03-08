import { Hono } from "hono";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { parseStoryCard, serializeStoryCard } from "../../format/story-card";
import type { StoryCard } from "../../format/story-card";

function loadAllCards(storiesDir: string): { card: StoryCard; filename: string }[] {
  if (!existsSync(storiesDir)) return [];
  const files = readdirSync(storiesDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  return files.map((filename) => {
    const content = readFileSync(join(storiesDir, filename), "utf-8");
    return { card: parseStoryCard(content), filename };
  });
}

function findCard(
  storiesDir: string,
  id: string
): { card: StoryCard; filename: string } | undefined {
  return loadAllCards(storiesDir).find((entry) => entry.card.id === id);
}

export function scenarioRoutes(dataDir: string) {
  const router = new Hono();
  const storiesDir = join(dataDir, "stories");

  router.get("/", (c) => {
    const entries = loadAllCards(storiesDir);
    const summaries = entries.map(({ card }) => ({
      id: card.id,
      title: card.title,
      status: card.status,
      tags: card.tags,
    }));
    return c.json(summaries);
  });

  router.get("/:id", (c) => {
    const entry = findCard(storiesDir, c.req.param("id"));
    if (!entry) return c.json({ error: "not found" }, 404);
    const { raw: _raw, ...rest } = entry.card;
    return c.json(rest);
  });

  router.put("/:id", async (c) => {
    const entry = findCard(storiesDir, c.req.param("id"));
    if (!entry) return c.json({ error: "not found" }, 404);

    const updates = await c.req.json();
    const updated: StoryCard = { ...entry.card, ...updates, id: entry.card.id };
    updated.raw = serializeStoryCard(updated);

    writeFileSync(join(storiesDir, entry.filename), updated.raw);

    const { raw: _raw, ...rest } = updated;
    return c.json(rest);
  });

  router.post("/:id/approve", (c) => {
    const entry = findCard(storiesDir, c.req.param("id"));
    if (!entry) return c.json({ error: "not found" }, 404);

    const updated: StoryCard = { ...entry.card, status: "ready" };
    updated.raw = serializeStoryCard(updated);

    writeFileSync(join(storiesDir, entry.filename), updated.raw);

    const { raw: _raw, ...rest } = updated;
    return c.json(rest);
  });

  return router;
}
