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
 * Sanitize an arbitrary string for use as (part of) a Chrome profile
 * name. `chrome-ws-lib.setProfileName` enforces
 * `/^[a-zA-Z0-9_-]+$/`; replace anything outside that set with `-`.
 */
export function sanitizeProfileSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-");
}
