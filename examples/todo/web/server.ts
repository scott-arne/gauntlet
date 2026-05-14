// HTTP server frontend for the TODO fixture. Long-running.
// In-memory state, persists via core.ts (which honors
// $TODO_STATE_FILE for harness-driven isolation).
//
// Don't use this as a starter. No auth, no CSRF, no rate limit.
// The point is a deterministic target for the Web adapter.

import { resolve } from "path";
import {
  loadState,
  saveState,
  addItem,
  toggleItem,
  deleteItem,
  setFilter,
  clearCompleted,
  type Filter,
} from "../core";

const PORT = Number(process.env.TODO_WEB_PORT ?? 7891);
const PUBLIC_DIR = resolve(import.meta.dir, "public");

let state = loadState();

function persist() {
  saveState(state);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (method === "GET" && path === "/api/state") {
    return jsonResponse(state);
  }
  if (method === "POST" && path === "/api/add") {
    const body = (await req.json()) as { text?: string };
    if (!body.text || typeof body.text !== "string") {
      return jsonResponse({ error: "text required" }, 400);
    }
    addItem(state, body.text);
    persist();
    return jsonResponse(state);
  }
  if (method === "POST" && path === "/api/toggle") {
    const body = (await req.json()) as { id?: string };
    if (!body.id) return jsonResponse({ error: "id required" }, 400);
    toggleItem(state, body.id);
    persist();
    return jsonResponse(state);
  }
  if (method === "POST" && path === "/api/delete") {
    const body = (await req.json()) as { id?: string };
    if (!body.id) return jsonResponse({ error: "id required" }, 400);
    deleteItem(state, body.id);
    persist();
    return jsonResponse(state);
  }
  if (method === "POST" && path === "/api/filter") {
    const body = (await req.json()) as { filter?: Filter };
    if (
      body.filter !== "all" &&
      body.filter !== "active" &&
      body.filter !== "completed"
    ) {
      return jsonResponse({ error: "filter must be all|active|completed" }, 400);
    }
    setFilter(state, body.filter);
    persist();
    return jsonResponse(state);
  }
  if (method === "POST" && path === "/api/clear-completed") {
    clearCompleted(state);
    persist();
    return jsonResponse(state);
  }
  return jsonResponse({ error: "not found" }, 404);
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, url);
    }
    // Serve index.html for "/" and anything not under /api/.
    const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolved = resolve(PUBLIC_DIR, "." + reqPath);
    // Guard against path traversal — keep resolved path inside PUBLIC_DIR.
    if (!resolved.startsWith(PUBLIC_DIR + "/") && resolved !== PUBLIC_DIR) {
      return new Response("not found", { status: 404 });
    }
    const file = Bun.file(resolved);
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`TODO fixture web server listening on http://localhost:${PORT}`);
