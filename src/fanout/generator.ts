import type { StoryCard } from "../format/story-card";
import { parseStoryCard } from "../format/story-card";
import type { LLMClient } from "../models/provider";
import type { VetResult } from "../types";

export function buildFanoutPrompt(card: StoryCard): string {
  return `You are a QA test designer. Given a story card, generate variation scenarios that test edge cases, error paths, alternate personas, and boundary conditions.

Each variation is a story card in the same format. Each MUST include:
- A unique id (use the parent id with a suffix, e.g., story-001-a, story-001-b)
- parent: ${card.id}
- A clear title describing the variation
- A description explaining what this variation tests
- Acceptance criteria (at least one)

## Parent Story Card

**ID:** ${card.id}
**Title:** ${card.title}
${card.stakeholder ? `**Stakeholder:** ${card.stakeholder}` : ""}

${card.description}

${card.acceptanceCriteria.length > 0 ? "## Acceptance Criteria\n" + card.acceptanceCriteria.map((c) => `- ${c}`).join("\n") : ""}

## Generate Variations

Think about:
- Edge cases (empty input, very long input, special characters)
- Error paths (network failure, invalid state, permission denied)
- Alternate personas (new user, power user, admin, mobile user)
- Boundary conditions (first item, last item, maximum items)
- Negative testing (what should NOT happen)

Generate 3-5 variations. Separate each card with a "---CARD---" marker.

Each card MUST use this exact format (triple-dash frontmatter, NOT code fences):

---
id: ${card.id}-a
title: Example variation title
status: draft
tags: edge-case
parent: ${card.id}
---

Description of what this variation tests.

## Acceptance Criteria

- First criterion
- Second criterion`;
}

export async function generateFanout(
  card: StoryCard,
  client: LLMClient
): Promise<string[]> {
  const prompt = buildFanoutPrompt(card);
  const response = await client.chat(
    [client.userMessage(prompt)],
    [],
    "You are a QA test designer. Output story cards in markdown format."
  );

  return splitAndValidateCards(response.text);
}

export function splitAndValidateCards(text: string): string[] {
  // Strip markdown code fences that LLMs sometimes wrap around output
  const stripped = text
    .replace(/^```\w*\s*\n/gm, "")
    .replace(/\n```\s*$/gm, "")
    .replace(/\n```\s*\n/gm, "\n");

  // Try explicit separator first
  let chunks = stripped.split("---CARD---").map((s) => s.trim()).filter(Boolean);

  // If no separator found, try splitting on YAML frontmatter boundaries
  if (chunks.length <= 1) {
    chunks = stripped.split(/\n(?=---\nid:)/).map((s) => s.trim()).filter(Boolean);
  }

  return chunks.filter((chunk) => {
    try {
      parseStoryCard(chunk);
      return true;
    } catch (e) {
      console.error(`Failed to parse generated card: ${e instanceof Error ? e.message : e}`);
      console.error(`Card text: ${chunk.slice(0, 200)}...`);
      return false;
    }
  });
}

// --- Observation promotion ---

export function buildObservationPrompt(result: VetResult): string {
  const observationList = result.observations
    .map((o) => `- [${o.kind}] ${o.description}`)
    .join("\n");

  return `You are a QA analyst. Given observations from a test run, generate a focused story card for each observation that needs follow-up.

Each card MUST include:
- A unique id (use the scenario name with a suffix, e.g., ${result.scenario}-obs-1)
- parent: ${result.scenario}
- tags: observation
- A clear title describing the issue or improvement
- A description explaining what was observed
- Acceptance criteria (at least one)

## Scenario: ${result.scenario}

## Observations

${observationList}

Generate one story card per observation. Output each as a complete story card in markdown format with YAML frontmatter, separated by "---CARD---" markers.`;
}

export async function generateFromObservations(
  result: VetResult,
  client: LLMClient
): Promise<string[]> {
  if (result.observations.length === 0) return [];

  const prompt = buildObservationPrompt(result);
  const response = await client.chat(
    [client.userMessage(prompt)],
    [],
    "You are a QA analyst. Output story cards in markdown format."
  );

  return splitAndValidateCards(response.text);
}

// --- Failure analysis ---

export function buildFailurePrompt(result: VetResult): string | null {
  if (result.status !== "fail") return null;

  return `You are a QA analyst. A test scenario has failed. Generate 2-3 follow-up story cards that investigate the root cause and verify the fix.

Each card MUST include:
- A unique id (use the scenario name with a suffix, e.g., ${result.scenario}-fail-1)
- parent: ${result.scenario}
- tags: failure-analysis
- A clear title describing the investigation
- A description explaining what to investigate
- Acceptance criteria (at least one)

## Failed Scenario: ${result.scenario}

**Summary:** ${result.summary}

**Reasoning:** ${result.reasoning}

Generate 2-3 follow-up cards. Output each as a complete story card in markdown format with YAML frontmatter, separated by "---CARD---" markers.`;
}

export async function generateFromFailure(
  result: VetResult,
  client: LLMClient
): Promise<string[]> {
  const prompt = buildFailurePrompt(result);
  if (prompt === null) return [];

  const response = await client.chat(
    [client.userMessage(prompt)],
    [],
    "You are a QA analyst. Output story cards in markdown format."
  );

  return splitAndValidateCards(response.text);
}
