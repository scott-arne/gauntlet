/**
 * WebSocket upgrade decision logic. Pure: given a URL + headers + an
 * optional origin allowlist, returns the upgrade payload or null
 * (caller treats null as "do not upgrade"). PRI-1483.
 *
 * Extracted from `src/index.ts` so the validation can be exercised
 * without spinning up a real server.
 */
import { parseRunId, parseRunSetId } from "../util/id";

export type UpgradeData =
  | { runId: string }
  | { runSetId: string };

export interface DecideUpgradeOptions {
  /** When non-empty, the request's `Origin` header must match one of
   * these strings exactly. When empty (or undefined), Origin is not
   * checked — this is the default. PRI-1483. */
  originAllowlist?: string[];
}

export function decideUpgrade(
  url: URL,
  headers: Headers,
  opts: DecideUpgradeOptions = {},
): UpgradeData | null {
  // Origin gate (defense-in-depth, opt-in via env).
  const allowlist = opts.originAllowlist;
  if (allowlist && allowlist.length > 0) {
    const origin = headers.get("origin");
    if (!origin || !allowlist.includes(origin)) return null;
  }

  // /api/ws/run-sets/<id>
  if (url.pathname.startsWith("/api/ws/run-sets/")) {
    const raw = url.pathname.slice("/api/ws/run-sets/".length);
    const runSetId = parseRunSetId(raw);
    if (!runSetId) return null;
    return { runSetId };
  }

  // /api/ws?run=<runId>
  if (url.pathname === "/api/ws") {
    const raw = url.searchParams.get("run");
    const runId = parseRunId(raw);
    if (!runId) return null;
    return { runId };
  }

  return null;
}
