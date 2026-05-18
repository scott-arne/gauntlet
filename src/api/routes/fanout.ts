import { Hono } from "hono";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseStoryCard } from "../../format/story-card";
import { generateFanout, generateFromObservations, generateFromFailure } from "../../fanout/generator";
import { createClient } from "../../models/resolve";
import { gauntletPath } from "../../paths";
import type { LLMClient } from "../../models/provider";
import type { VetResult } from "../../types";
import type { AppConfig } from "../../config";
import { findCard } from "../../cards/store";
import type { ErrorLog } from "../../util/error-log";
import type { ParseResult } from "../../agent/validators";

function resolveClient(config: AppConfig, clientFactory?: () => LLMClient): ParseResult<LLMClient> {
  if (clientFactory) return { ok: true, value: clientFactory() };
  const model = config.models.fanout ?? config.models.agent;
  if (config.models.available.length > 0 && !config.models.available.includes(model)) {
    return { ok: false, reason: `model "${model}" is not in GAUNTLET_MODELS allow-list` };
  }
  return { ok: true, value: createClient(model) };
}

function writeCards(
  storiesDir: string,
  cardTexts: string[],
  errorLog?: ErrorLog,
) {
  mkdirSync(storiesDir, { recursive: true });
  const seen = new Set<string>();
  const written: { id: string; title: string; filename: string }[] = [];
  for (const text of cardTexts) {
    const card = parseStoryCard(text);
    if (seen.has(card.id)) {
      // Duplicate id within the same batch — keep the first, skip this one
      // rather than silently overwrite. A correct LLM prompt should never
      // emit two cards with the same id.
      errorLog?.add(
        "fanout",
        `duplicate card id "${card.id}" in generated batch — skipping duplicate`,
      );
      continue;
    }
    seen.add(card.id);
    const filename = `${card.id}.md`;
    writeFileSync(join(storiesDir, filename), text);
    written.push({ id: card.id, title: card.title, filename });
  }
  return written;
}

type Mode = "observations" | "failure";

interface ModeConfig {
  generator: (result: VetResult, client: LLMClient) => Promise<string[]>;
  errorLabel: string;
  // Returns an error message to send as 400, or null to proceed.
  // Observations has no precondition check (zero observations is a success
  // with empty results, handled separately below); failure requires
  // status === "fail".
  preflight?: (result: VetResult) => string | null;
}

const MODES: Record<Mode, ModeConfig> = {
  observations: {
    generator: generateFromObservations,
    errorLabel: "observations",
  },
  failure: {
    generator: generateFromFailure,
    errorLabel: "failure analysis",
    preflight: (r) => (r.status !== "fail" ? "result is not a failure" : null),
  },
};

function isMode(s: string): s is Mode {
  return s === "observations" || s === "failure";
}

export function fanoutRoutes(config: AppConfig, clientFactory?: () => LLMClient, errorLog?: ErrorLog) {
  const router = new Hono();
  const projectRoot = config.projectRoot;
  const storiesDir = gauntletPath(projectRoot, "stories");

  router.post("/:id", async (c) => {
    const cardId = c.req.param("id");
    const entry = findCard(projectRoot, cardId, errorLog);
    if (!entry) return c.json({ error: "not found" }, 404);

    const resolved = resolveClient(config, clientFactory);
    if (!resolved.ok) return c.json({ error: resolved.reason }, 400);

    try {
      const cardTexts = await generateFanout(entry.card, resolved.value);
      const generated = writeCards(storiesDir, cardTexts, errorLog);
      return c.json({ parent: entry.card.id, generated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorLog?.add("fanout", `${entry.card.id}: ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  router.post("/:id/:mode", async (c) => {
    const mode = c.req.param("mode");
    if (!isMode(mode)) return c.json({ error: "unknown mode" }, 404);
    const modeConfig = MODES[mode];

    const runId = c.req.param("id");
    const resultPath = gauntletPath(projectRoot, "results", runId, "result.json");
    if (!existsSync(resultPath)) return c.json({ error: "not found" }, 404);

    const result: VetResult = JSON.parse(readFileSync(resultPath, "utf-8"));
    const cardId = result.scenario;

    const preflightError = modeConfig.preflight?.(result);
    if (preflightError) return c.json({ error: preflightError }, 400);

    // Observations mode: zero observations is a legitimate zero-result
    // success, not an error. Skip the LLM call and return empty generated.
    if (mode === "observations" && result.observations.length === 0) {
      return c.json({ parent: cardId, runId, generated: [] });
    }

    const resolved = resolveClient(config, clientFactory);
    if (!resolved.ok) return c.json({ error: resolved.reason }, 400);

    try {
      const cardTexts = await modeConfig.generator(result, resolved.value);
      const generated = writeCards(storiesDir, cardTexts, errorLog);
      return c.json({ parent: cardId, runId, generated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorLog?.add("fanout", `${modeConfig.errorLabel} for ${cardId} (run ${runId}): ${message}`);
      return c.json({ error: message }, 500);
    }
  });

  return router;
}
