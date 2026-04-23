import { Hono } from "hono";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { isSafePath } from "../../paths";
import { getMimeType } from "../mime-types";
import type { ActiveRunRegistry } from "../active-runs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Parse an integer query param, defaulting and clamping to a valid range.
 * A value that doesn't parse as an integer collapses to `fallback` rather
 * than erroring — matches the tolerant convention used elsewhere in this API.
 */
function parseIntParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function resultRoutes(resultsDir: string, registry?: ActiveRunRegistry) {
  const router = new Hono();

  // Paginated list. Response shape:
  //   { results: VetResult[]; total: number; limit: number; offset: number }
  //
  // Query params:
  //   ?limit=<n>   max entries (default 50, clamped to 1..200)
  //   ?offset=<n>  skip N entries (default 0, clamped to >=0)
  //   ?cardId=<s>  only include runs whose scenario matches this cardId
  //
  // Sort is runId-desc before offset/limit. The runId's composite shape
  // (`<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>`) makes lex-desc equivalent to
  // chrono-desc *per card*. Across cards the ordering interleaves by cardId
  // first, timestamp second — which is acceptable: the primary consumer
  // groups by cardId in the UI anyway, and the older flat listing was in
  // whatever order readdir returned (no guarantee).
  router.get("/", (c) => {
    const limit = parseIntParam(c.req.query("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = parseIntParam(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const cardId = c.req.query("cardId");

    if (!existsSync(resultsDir)) {
      return c.json({ results: [], total: 0, limit, offset });
    }

    const entries = readdirSync(resultsDir, { withFileTypes: true });
    // Sort directory names desc up front — cheap, avoids loading files
    // for rows the caller is going to page past anyway.
    const runIds = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

    // Apply cardId filter before loading. runIds are shaped
    // `<cardId>_<ts>_<nonce>` (see `makeRunId`) and cardIds can't contain
    // `_` (story-card parse enforces `[a-zA-Z0-9-]`), so a `<cardId>_`
    // prefix match is unambiguous and lets us skip file reads for
    // non-matching dirs.
    const filteredRunIds = cardId
      ? runIds.filter((id) => id.startsWith(`${cardId}_`))
      : runIds;

    const total = filteredRunIds.length;
    const page = filteredRunIds.slice(offset, offset + limit);

    const results: unknown[] = [];
    for (const runId of page) {
      const path = join(resultsDir, runId, "result.json");
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, "utf-8");
        results.push(JSON.parse(content));
      } catch {
        // Skip malformed result files
      }
    }

    return c.json({ results, total, limit, offset });
  });

  // `:runId` is the run directory name on disk — produced by `makeRunId`
  // and shaped like `<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>`. The route
  // accepts any safe path segment; the safe-path guard prevents escape.
  router.get("/:runId", (c) => {
    const runId = c.req.param("runId");
    const resultPath = join(resultsDir, runId, "result.json");

    if (!isSafePath(resultsDir, resultPath)) {
      return c.json({ error: "invalid path" }, 400);
    }

    if (!existsSync(resultPath)) {
      return c.json({ error: "not found" }, 404);
    }

    try {
      const content = readFileSync(resultPath, "utf-8");
      return c.json(JSON.parse(content));
    } catch {
      return c.json({ error: "malformed result file" }, 500);
    }
  });

  // File route: serves a file from a run directory. Path traversal outside
  // the run dir is always blocked.
  //
  // Gating rules:
  //   - If the run is currently active (ActiveRunRegistry), we skip the
  //     manifest check and serve any file that exists under the run dir.
  //     result.json hasn't been written yet, but screenshots + artifacts +
  //     run.jsonl are being produced live — the transcript view (and
  //     anything else watching a run) needs them.
  //   - If the run is complete, the manifest is authoritative: the file
  //     must be listed in result.json. See docs/format.md.
  router.get("/:runId/file/:path{.+}", (c) => {
    const runId = c.req.param("runId");
    const relPath = c.req.param("path");
    const runDir = join(resultsDir, runId);

    if (!isSafePath(resultsDir, runDir)) {
      return c.json({ error: "invalid path" }, 400);
    }

    const filePath = join(runDir, relPath);
    if (!isSafePath(runDir, filePath)) {
      return c.json({ error: "invalid path" }, 400);
    }

    const live = registry?.has(runId) ?? false;
    if (!live) {
      const manifestPath = join(runDir, "result.json");
      if (!existsSync(manifestPath)) {
        return c.json({ error: "run not found" }, 404);
      }
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      } catch {
        return c.json({ error: "malformed result" }, 500);
      }
      if (!collectManifestPaths(manifest).has(relPath)) {
        return c.json({ error: "not in manifest" }, 404);
      }
    }

    if (!existsSync(filePath)) {
      return c.json({ error: "not found" }, 404);
    }

    const content = readFileSync(filePath);
    const ext = relPath.split(".").pop() || "";
    return new Response(content, {
      headers: { "Content-Type": getMimeType(ext) },
    });
  });

  return router;
}

// Extracts every path reference from a parsed result.json. The set returned
// is the authoritative list of files the manifest claims belong to the run.
function collectManifestPaths(manifest: unknown): Set<string> {
  const paths = new Set<string>();
  if (!manifest || typeof manifest !== "object") return paths;
  const m = manifest as Record<string, unknown>;

  const evidence = m.evidence;
  if (evidence && typeof evidence === "object") {
    const e = evidence as Record<string, unknown>;
    if (Array.isArray(e.screenshots)) {
      for (const s of e.screenshots) if (typeof s === "string") paths.add(s);
    }
    if (typeof e.log === "string") paths.add(e.log);
    if (typeof e.video === "string") paths.add(e.video);
    if (Array.isArray(e.artifacts)) {
      for (const a of e.artifacts) if (typeof a === "string") paths.add(a);
    }
    if (Array.isArray(e.captures)) {
      // Captures are stored as pairs: the manifest records the `.ansi`
      // path; the parsed `.json` twin at the same stem is not in the
      // manifest but is an implicit sibling. Allow both so the UI can
      // fetch the pre-parsed grid without an extra manifest entry.
      for (const a of e.captures) {
        if (typeof a !== "string") continue;
        paths.add(a);
        if (a.endsWith(".ansi")) paths.add(a.slice(0, -5) + ".json");
      }
    }
  }

  if (Array.isArray(m.observations)) {
    for (const obs of m.observations) {
      if (obs && typeof obs === "object" && Array.isArray((obs as { evidence?: unknown }).evidence)) {
        for (const p of (obs as { evidence: unknown[] }).evidence) {
          if (typeof p === "string") paths.add(p);
        }
      }
    }
  }

  return paths;
}
