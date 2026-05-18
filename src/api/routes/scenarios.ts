import { Hono } from "hono";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { serializeStoryCard } from "../../format/story-card";
import type { StoryCard } from "../../format/story-card";
import { asCardId } from "../../util/brands";
import { loadAllCards, findCard } from "../../cards/store";
import { isSafePath, gauntletPath } from "../../paths";
import type { ErrorLog } from "../../util/error-log";

/**
 * Type-checked subset of StoryCard fields that scenario create/update bodies
 * may carry. `id` is required on POST and forbidden on PUT (the path param
 * is authoritative). Status semantics — draft vs ready vs UI-specific — are
 * an open question separate from this validation, so the parser checks the
 * shape of `status` (must be a string) but does NOT gate its values.
 */
interface ScenarioBody {
  id?: string;
  title?: string;
  status?: string;
  tags?: string[];
  parent?: string;
  stakeholder?: string;
  description?: string;
  acceptanceCriteria?: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseScenarioBody(raw: unknown, kind: "create" | "update"): ScenarioBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;

  const out: ScenarioBody = {};

  if (kind === "create") {
    if (typeof b.id !== "string" || b.id.length === 0) {
      throw new Error("id: required and must be a non-empty string");
    }
    out.id = b.id;
    if (typeof b.title !== "string" || b.title.length === 0) {
      throw new Error("title: required and must be a non-empty string");
    }
    out.title = b.title;
  } else {
    if (b.id !== undefined) {
      throw new Error("id: must not be set on update (path param is authoritative)");
    }
    if (b.title !== undefined) {
      if (typeof b.title !== "string" || b.title.length === 0) {
        throw new Error("title: must be a non-empty string if present");
      }
      out.title = b.title;
    }
  }

  if (b.status !== undefined) {
    if (typeof b.status !== "string") {
      throw new Error("status: must be a string if present");
    }
    out.status = b.status;
  }
  if (b.tags !== undefined) {
    if (!isStringArray(b.tags)) {
      throw new Error("tags: must be a string[] if present");
    }
    out.tags = b.tags;
  }
  if (b.parent !== undefined) {
    if (typeof b.parent !== "string") {
      throw new Error("parent: must be a string if present");
    }
    out.parent = b.parent;
  }
  if (b.stakeholder !== undefined) {
    if (typeof b.stakeholder !== "string") {
      throw new Error("stakeholder: must be a string if present");
    }
    out.stakeholder = b.stakeholder;
  }
  if (b.description !== undefined) {
    if (typeof b.description !== "string") {
      throw new Error("description: must be a string if present");
    }
    out.description = b.description;
  }
  if (b.acceptanceCriteria !== undefined) {
    if (!isStringArray(b.acceptanceCriteria)) {
      throw new Error("acceptanceCriteria: must be a string[] if present");
    }
    out.acceptanceCriteria = b.acceptanceCriteria;
  }

  return out;
}

export function scenarioRoutes(projectRoot: string, errorLog?: ErrorLog) {
  const router = new Hono();
  const storiesDir = gauntletPath(projectRoot, "stories");

  router.get("/", (c) => {
    const entries = loadAllCards(projectRoot, errorLog);
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
    let body: ScenarioBody;
    try {
      const raw = await c.req.json();
      body = parseScenarioBody(raw, "create");
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    // parseScenarioBody guarantees id and title on create.
    const id = body.id!;
    const title = body.title!;

    const targetPath = join(storiesDir, `${id}.md`);
    if (!isSafePath(storiesDir, targetPath)) {
      return c.json({ error: "invalid id" }, 400);
    }

    const existing = findCard(projectRoot, id, errorLog);
    if (existing) {
      return c.json({ error: "card already exists" }, 409);
    }

    const card: StoryCard = {
      // HTTP boundary: route param/body strings become branded ids.
      id: asCardId(id),
      title,
      status: body.status ?? "draft",
      tags: body.tags ?? [],
      parent: body.parent ? asCardId(body.parent) : undefined,
      stakeholder: body.stakeholder,
      description: body.description ?? "",
      acceptanceCriteria: body.acceptanceCriteria ?? [],
      raw: "",
    };
    card.raw = serializeStoryCard(card);

    mkdirSync(storiesDir, { recursive: true });
    writeFileSync(join(storiesDir, `${card.id}.md`), card.raw);

    const { raw: _raw, ...rest } = card;
    return c.json(rest, 201);
  });

  router.delete("/:id", (c) => {
    const entry = findCard(projectRoot, c.req.param("id"), errorLog);
    if (!entry) return c.json({ error: "not found" }, 404);

    unlinkSync(join(storiesDir, entry.filename));
    return c.json({ deleted: entry.card.id });
  });

  router.get("/:id", (c) => {
    const entry = findCard(projectRoot, c.req.param("id"), errorLog);
    if (!entry) return c.json({ error: "not found" }, 404);
    const { raw: _raw, ...rest } = entry.card;
    return c.json(rest);
  });

  router.put("/:id", async (c) => {
    const entry = findCard(projectRoot, c.req.param("id"), errorLog);
    if (!entry) return c.json({ error: "not found" }, 404);

    let updates: ScenarioBody;
    try {
      const raw = await c.req.json();
      updates = parseScenarioBody(raw, "update");
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    // HTTP boundary: brand parent (route-body string) before merging into
    // the existing card. id always comes from the path-bound entry.
    const brandedParent = updates.parent !== undefined
      ? asCardId(updates.parent)
      : entry.card.parent;
    const updated: StoryCard = {
      ...entry.card,
      ...updates,
      id: entry.card.id,
      parent: brandedParent,
    };
    updated.raw = serializeStoryCard(updated);

    writeFileSync(join(storiesDir, entry.filename), updated.raw);

    const { raw: _raw, ...rest } = updated;
    return c.json(rest);
  });

  router.post("/:id/approve", (c) => {
    const entry = findCard(projectRoot, c.req.param("id"), errorLog);
    if (!entry) return c.json({ error: "not found" }, 404);

    const updated: StoryCard = { ...entry.card, status: "ready" };
    updated.raw = serializeStoryCard(updated);

    writeFileSync(join(storiesDir, entry.filename), updated.raw);

    const { raw: _raw, ...rest } = updated;
    return c.json(rest);
  });

  return router;
}
