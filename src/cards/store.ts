import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parseStoryCard, type StoryCard } from "../format/story-card";
import { gauntletPath } from "../paths";
import type { ErrorLog } from "../util/error-log";

export interface CardEntry {
  card: StoryCard;
  filename: string;
}

/**
 * Fast path: read the file at the expected filename (`<id>.md`). If the
 * direct-hit file exists but fails to parse, we throw — the caller
 * explicitly asked for this id, so a malformed match is a real failure,
 * not something to silently skip.
 *
 * Fallback scan: only when the direct hit doesn't exist. Old fanout-
 * generated cards can use patterns like `<parent>-<letter>.md`, so we
 * still need a directory walk to find them. During the fallback, parse
 * failures on *other* files are logged and skipped so one malformed
 * card can't hide a legitimate match.
 */
export function findCard(
  projectRoot: string,
  id: string,
  errorLog?: ErrorLog,
): CardEntry | undefined {
  const storiesDir = gauntletPath(projectRoot, "stories");
  const directPath = join(storiesDir, `${id}.md`);

  if (existsSync(directPath)) {
    const content = readFileSync(directPath, "utf-8");
    const card = parseStoryCard(content); // direct hit: throw on parse failure
    if (card.id === id) {
      return { card, filename: `${id}.md` };
    }
    // File exists at <id>.md but its frontmatter id doesn't match (someone
    // renamed the file without updating frontmatter). Fall through to the
    // scan — maybe another file has the right id.
  }

  return loadAllCards(projectRoot, errorLog).find((entry) => entry.card.id === id);
}

/**
 * Returns all parseable cards in the stories dir, sorted by filename.
 * Malformed files are reported to `errorLog` (source: "cards") and
 * skipped so one bad card doesn't 500 the listing endpoint.
 */
export function loadAllCards(
  projectRoot: string,
  errorLog?: ErrorLog,
): CardEntry[] {
  const storiesDir = gauntletPath(projectRoot, "stories");
  if (!existsSync(storiesDir)) return [];

  const files = readdirSync(storiesDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const entries: CardEntry[] = [];
  for (const filename of files) {
    try {
      const content = readFileSync(join(storiesDir, filename), "utf-8");
      entries.push({ card: parseStoryCard(content), filename });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorLog?.add("cards", `${filename}: ${message}`);
    }
  }
  return entries;
}
