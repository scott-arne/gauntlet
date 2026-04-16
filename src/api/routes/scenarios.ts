import { Hono } from "hono";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { serializeStoryCard } from "../../format/story-card";
import type { StoryCard } from "../../format/story-card";
import { loadAllCards, findCard } from "./helpers";
import { isSafePath } from "../safe-path";
import { gauntletPath } from "../../paths";

export function scenarioRoutes(projectRoot: string) {
  const router = new Hono();
  const storiesDir = gauntletPath(projectRoot, "stories");

  router.get("/", (c) => {
    const entries = loadAllCards(storiesDir);
    const summaries = entries.map(({ card }) => ({
      id: card.id,
      title: card.title,
      status: card.status,
      tags: card.tags,
      ...(card.parent ? { parent: card.parent } : {}),
    }));
    return c.json(summaries);
  });

  router.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.id || !body.title) {
      return c.json({ error: "id and title are required" }, 400);
    }

    const targetPath = join(storiesDir, `${body.id}.md`);
    if (!isSafePath(storiesDir, targetPath)) {
      return c.json({ error: "invalid id" }, 400);
    }

    const existing = findCard(storiesDir, body.id);
    if (existing) {
      return c.json({ error: "card already exists" }, 409);
    }

    const card: StoryCard = {
      id: body.id,
      title: body.title,
      status: body.status || "draft",
      tags: body.tags || [],
      parent: body.parent,
      stakeholder: body.stakeholder,
      description: body.description || "",
      acceptanceCriteria: body.acceptanceCriteria || [],
      raw: "",
    };
    card.raw = serializeStoryCard(card);

    mkdirSync(storiesDir, { recursive: true });
    writeFileSync(join(storiesDir, `${card.id}.md`), card.raw);

    const { raw: _raw, ...rest } = card;
    return c.json(rest, 201);
  });

  router.delete("/:id", (c) => {
    const entry = findCard(storiesDir, c.req.param("id"));
    if (!entry) return c.json({ error: "not found" }, 404);

    unlinkSync(join(storiesDir, entry.filename));
    return c.json({ deleted: entry.card.id });
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
