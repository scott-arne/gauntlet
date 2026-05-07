import type { StoryCard } from "../format/story-card";
import { loadPromptFile } from "./prompts/loader";
import { isAdapterType } from "../adapters/adapter";

// Exported for tests that want to diff the prose against the spec.
export function getContextSectionTemplate(): string {
  return loadPromptFile("context");
}
export const CONTEXT_SECTION_TEMPLATE = getContextSectionTemplate();

export function buildSystemPrompt(
  card: StoryCard,
  contextTree?: string,
  adapterName?: string,
): string {
  const parts: string[] = [];

  parts.push(loadPromptFile("persona"));

  // Story Card block — header, identifying lines, and description are
  // one block (sub-lines joined by \n; the description is offset by a
  // blank line within the block).
  const storyLines: string[] = [`## Story Card`, ``, `**ID:** ${card.id}`, `**Title:** ${card.title}`];
  if (card.stakeholder) storyLines.push(`**Stakeholder:** ${card.stakeholder}`);
  storyLines.push(``, card.description);
  parts.push(storyLines.join("\n"));

  if (card.acceptanceCriteria.length > 0) {
    // Acceptance Criteria block — header, bullets (adjacent), then the
    // "Evaluate..." closer offset by a blank line. Single block so the
    // joiner doesn't insert blanks between bullets.
    const critLines: string[] = [`## Acceptance Criteria`];
    for (const criterion of card.acceptanceCriteria) {
      critLines.push(`- ${criterion}`);
    }
    critLines.push(``, `Evaluate each criterion based on what you observe. Use your judgment.`);
    parts.push(critLines.join("\n"));
  } else {
    parts.push(
      `This story has no explicit acceptance criteria. You should explore the application freely and report what you find. Judge whether the story's intent is satisfied.`
    );
  }

  parts.push(loadPromptFile("evaluation"));

  // Per-adapter overlay (e.g. web side-trip guidance). Whitelisted to
  // the known adapter types so a missing adapter-{name}.md for a real
  // adapter is a hard error (per spec), while test-fake adapter names
  // (e.g. "test" in event-stream tests) silently contribute nothing.
  if (adapterName && isAdapterType(adapterName)) {
    const adapterPrompt = loadPromptFile(`adapter-${adapterName}`);
    if (adapterPrompt.length > 0) {
      parts.push(adapterPrompt);
    }
  }

  // Context section — last block, only when populated. Spec §4.4.
  if (contextTree && contextTree.length > 0) {
    parts.push(
      loadPromptFile("context").replace("{{TREE_LISTING}}", contextTree),
    );
  }

  return parts.join("\n\n");
}
