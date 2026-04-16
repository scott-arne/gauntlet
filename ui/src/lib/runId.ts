/**
 * Helpers for parsing runIds into display-friendly bits.
 *
 * A runId has the shape `<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>` — produced by
 * `src/util/id.ts#makeRunId` server-side. We only ever parse them in the UI,
 * never compose them; the backend is authoritative.
 *
 * The separator is `_`. Story-card ids are `[a-zA-Z0-9-]`, so the `_` is
 * unambiguous: the last two underscore-separated segments are always
 * `<timestamp>` and `<nonce>`; everything before is the cardId (which may
 * itself contain `-`).
 */

/** Best-effort split of a runId. Returns null if the shape doesn't match. */
export function parseRunId(runId: string): {
  cardId: string;
  timestamp: string;
  nonce: string;
} | null {
  const parts = runId.split("_");
  if (parts.length < 3) return null;
  const nonce = parts[parts.length - 1];
  const timestamp = parts[parts.length - 2];
  const cardId = parts.slice(0, -2).join("_");
  if (!cardId || !/^\d{8}T\d{6}Z$/.test(timestamp)) return null;
  return { cardId, timestamp, nonce };
}

/**
 * Render the timestamp portion of a runId as `HH:MM:SS` in the viewer's local
 * timezone. Returns an empty string if the runId shape is unexpected.
 */
export function formatRunTimestamp(runId: string): string {
  const parsed = parseRunId(runId);
  if (!parsed) return "";
  // `YYYYMMDDTHHMMSSZ` → `YYYY-MM-DDTHH:MM:SSZ` for Date parsing.
  const iso = parsed.timestamp.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    "$1-$2-$3T$4:$5:$6Z",
  );
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
