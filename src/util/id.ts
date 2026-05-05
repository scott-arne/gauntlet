/**
 * Compose a self-describing run id from a cardId, an ISO 8601 basic-format
 * UTC timestamp, and a 4-char base36 nonce:
 *
 *   <cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>
 *
 * Example: `login-001_20260416T142301Z_k3xm`
 *
 * - The cardId is preserved verbatim. Story-card parsing already enforces
 *   `[a-zA-Z0-9-]`, so it is filesystem-safe and contains no `_`, which
 *   makes the `_` separator unambiguous.
 * - The timestamp is the primary source of uniqueness; the 4-char nonce
 *   only resolves same-second collisions.
 * - Lex-sortable (left-anchored cardId, then chrono) — agents reading
 *   `.gauntlet/results/` can tell which card tested and when at a glance.
 */
export function makeRunId(cardId: string): string {
  const ts = isoBasicNow();
  const nonce = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${cardId}_${ts}_${nonce}`;
}

/**
 * Compose a run set id from a kind (single or batch), an ISO 8601 basic-format
 * UTC timestamp, and a 4-char base36 nonce:
 *
 *   <kind>_<YYYYMMDDTHHMMSSZ>_<nonce>
 *
 * Example: `batch_20260416T142301Z_k3xm`
 *
 * The kind is preserved verbatim (single or batch), followed by the timestamp
 * for chronological ordering, and a 4-char nonce to resolve same-second collisions.
 */
export function makeRunSetId(kind: "single" | "batch"): string {
  const ts = isoBasicNow();
  const nonce = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${kind}_${ts}_${nonce}`;
}

/**
 * ISO 8601 basic-format UTC timestamp at second precision: `YYYYMMDDTHHMMSSZ`.
 * No hyphens, no colons — safe in path segments and Chrome profile names.
 */
function isoBasicNow(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Parse and validate a runId. Returns the runId on success, null on
 * failure. The shape is `<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>` where
 * cardId is `[a-zA-Z0-9-]+`, the timestamp is ISO 8601 basic format at
 * second precision, and the nonce is 4 base36 chars. PRI-1483.
 *
 * Rejecting empty/malformed runIds at the WebSocket upgrade boundary
 * means downstream consumers (path lookups, broadcaster keys) never
 * see hostile inputs. The strict format check also implicitly rejects
 * traversal sequences (`..`, `/`, etc).
 */
const RUN_ID_RE = /^[a-zA-Z0-9-]+_\d{8}T\d{6}Z_[a-z0-9]{4}$/;
export function parseRunId(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  return RUN_ID_RE.test(s) ? s : null;
}

/**
 * Parse and validate a run-set id. Mirrors `parseRunId`. The shape is
 * `<kind>_<YYYYMMDDTHHMMSSZ>_<nonce>` where kind is `single` or `batch`.
 */
const RUN_SET_ID_RE = /^(?:single|batch)_\d{8}T\d{6}Z_[a-z0-9]{4}$/;
export function parseRunSetId(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  return RUN_SET_ID_RE.test(s) ? s : null;
}

/**
 * Sanitize an arbitrary string for use as (part of) a Chrome profile
 * name. `chrome-ws-lib.setProfileName` enforces
 * `/^[a-zA-Z0-9_-]+$/`; replace anything outside that set with `-`.
 */
export function sanitizeProfileSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-");
}
