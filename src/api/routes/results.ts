import { Hono } from "hono";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { isSafePath } from "../safe-path";
import { getMimeType } from "../mime-types";

export function resultRoutes(resultsDir: string) {
  const router = new Hono();

  router.get("/", (c) => {
    if (!existsSync(resultsDir)) {
      return c.json([]);
    }

    const entries = readdirSync(resultsDir, { withFileTypes: true });
    const results: unknown[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(resultsDir, e.name, "result.json");
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, "utf-8");
        results.push(JSON.parse(content));
      } catch {
        // Skip malformed result files
      }
    }

    return c.json(results);
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

  // Manifest-gated file route: serves a file from a run directory only if
  // the run's result.json lists it. The manifest is authoritative; arbitrary
  // files on disk are not accessible through the API. See docs/format.md.
  router.get("/:runId/file/:path{.+}", (c) => {
    const runId = c.req.param("runId");
    const relPath = c.req.param("path");
    const runDir = join(resultsDir, runId);
    const manifestPath = join(runDir, "result.json");

    if (!isSafePath(resultsDir, runDir)) {
      return c.json({ error: "invalid path" }, 400);
    }

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

    const filePath = join(runDir, relPath);
    if (!isSafePath(runDir, filePath)) {
      return c.json({ error: "invalid path" }, 400);
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
