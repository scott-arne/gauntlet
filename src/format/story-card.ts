import { asCardId, type CardId } from "../util/brands";

export interface StoryCard {
  id: CardId;
  title: string;
  status: string;
  tags: string[];
  /**
   * Parent card id, set by fanout to record lineage. This is
   * informational: it does NOT imply run order or dependency.
   * Cards must be runnable in any order and in isolation — the
   * runner provides fresh browser state per story (Gauntlet
   * v1.5). If a card needs setup state, it must perform that
   * setup itself.
   */
  parent?: CardId;
  stakeholder?: string;
  description: string;
  acceptanceCriteria: string[];
  raw: string;
}

export function parseStoryCard(content: string): StoryCard {
  const { frontmatter, body } = splitFrontmatter(content);

  const id = frontmatter.id;
  const title = frontmatter.title;
  if (!id) throw new Error("Story card missing required field: id");
  if (!title) throw new Error("Story card missing required field: title");

  const { description, acceptanceCriteria } = parseBody(body);

  return {
    id: asCardId(id),
    title,
    status: frontmatter.status || "draft",
    tags: frontmatter.tags
      ? frontmatter.tags
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean)
      : [],
    parent: frontmatter.parent ? asCardId(frontmatter.parent) : undefined,
    stakeholder: frontmatter.stakeholder || undefined,
    description,
    acceptanceCriteria,
    raw: content,
  };
}

function splitFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    frontmatter[key] = value;
  }

  return { frontmatter, body: match[2].trim() };
}

function parseBody(body: string): {
  description: string;
  acceptanceCriteria: string[];
} {
  const marker = "## Acceptance Criteria";
  const markerIndex = body.indexOf(marker);

  if (markerIndex === -1) {
    return { description: body.trim(), acceptanceCriteria: [] };
  }

  const description = body.slice(0, markerIndex).trim();
  const criteriaSection = body.slice(markerIndex + marker.length).trim();

  // Criteria are markdown list items, and prose criteria soft-wrap across
  // lines. Continuation lines (indented or lazy) belong to the current
  // bullet and are joined with a space; a blank line ends the bullet, so
  // trailing commentary paragraphs are not absorbed. Truncating to the
  // first line silently dropped the operational half of long criteria —
  // see PRI-2160.
  const acceptanceCriteria: string[] = [];
  let current: string[] | null = null;
  for (const rawLine of criteriaSection.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#")) {
      // A new heading ends the criteria section entirely — its prose
      // must not be glommed onto the last bullet.
      break;
    }
    if (line.startsWith("- ")) {
      if (current) acceptanceCriteria.push(current.join(" "));
      current = [line.slice(2).trim()];
    } else if (line === "") {
      if (current) acceptanceCriteria.push(current.join(" "));
      current = null;
    } else if (current) {
      current.push(line);
    }
    // Non-bullet text outside a bullet (current === null) is ignored,
    // matching the previous behavior for stray prose in the section.
  }
  if (current) acceptanceCriteria.push(current.join(" "));

  return { description, acceptanceCriteria };
}

export function serializeStoryCard(card: StoryCard): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${card.id}`);
  lines.push(`title: ${card.title}`);
  lines.push(`status: ${card.status}`);
  if (card.tags.length) lines.push(`tags: ${card.tags.join(", ")}`);
  if (card.parent) lines.push(`parent: ${card.parent}`);
  if (card.stakeholder) lines.push(`stakeholder: ${card.stakeholder}`);
  lines.push("---");
  lines.push("");
  lines.push(card.description);
  if (card.acceptanceCriteria.length) {
    lines.push("");
    lines.push("## Acceptance Criteria");
    for (const criterion of card.acceptanceCriteria) {
      lines.push(`- ${criterion}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
