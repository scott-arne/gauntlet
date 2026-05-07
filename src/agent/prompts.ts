import type { StoryCard } from "../format/story-card";
import { loadPromptFile } from "./prompts/loader";

// The Context section prose is authoritative from Gauntlet v1.5 spec §4.1.
// DO NOT edit without going through the amendment protocol (spec §13).
// The tests assert this exact string — if a typo sneaks in, the prompts
// test breaks at CI time. The three-paragraph framing is load-bearing:
//
//   - "freeform data store" discourages the agent from assuming schema
//   - "stories refer to users by name" cues the credential-discovery model
//   - "tree is below" tells the agent the tree is ground truth, not a hint
//   - the closing paragraph's "built once at the start of the run and
//     does not change" is the prose face of the immutability invariant
//     (spec §4.2).
const CONTEXT_SECTION_PROSE =
  "## Context\n\n" +
  "The project has a context directory at `.gauntlet/context/`. This is a\n" +
  "freeform data store the story author set up for this project. Read files\n" +
  "with `read` and pull out whatever you need to carry out the story.\n\n" +
  "Stories will often refer to users by name (\"Alice\", \"as bob\") without\n" +
  "spelling out credentials. When that happens, look for a matching path in\n" +
  "the tree below, `read` the relevant files, and use what you find to log\n" +
  "in via the regular browser tools. A profile directory typically contains\n" +
  "an identity file (prose describing the person) and a credentials file;\n" +
  "some also contain `passkey.yaml` for WebAuthn sign-in via\n" +
  "`install_passkey`.\n\n" +
  "Below is the complete tree of everything available under\n" +
  "`.gauntlet/context/` for this run. File sizes in bytes are shown after\n" +
  "each entry. This listing is the full map: it is built once at the start\n" +
  "of the run and does not change while the run is in flight, so you do not\n" +
  "need to — and cannot — re-list the directory. Every file you might need\n" +
  "is in this tree; if a path is not shown here, it does not exist.\n\n" +
  "### .gauntlet/context/\n" +
  "{{TREE_LISTING}}";

// Exported for tests that want to diff the prose against the spec.
export const CONTEXT_SECTION_TEMPLATE = CONTEXT_SECTION_PROSE;

// PRI-1439: side-trip tab guidance for the web adapter. Surfaces the
// new_tab/close_tab tool pair as the right answer for the OTP /
// password-manager / 2FA-portal case, and explicitly steers off
// `navigate`, which would trash the original page's state.
const WEB_SIDE_TRIP_GUIDANCE =
  "\n## Side trips for sign-in flows\n\n" +
  "If a sign-in asks you to fetch a code from email, retrieve a password " +
  "from a password manager, or visit another site for a verification " +
  "step, use `new_tab(url)` to open that site in a side tab. Work there " +
  "as you normally would. When done, call `close_tab` to return to the " +
  "original page — its form values, cookies, and scroll position will " +
  "be intact. Do NOT use `navigate` for side trips: it resets the " +
  "original page state and you will have to start the sign-in over.";

export function buildSystemPrompt(
  card: StoryCard,
  contextTree?: string,
  adapterName?: string,
): string {
  const parts: string[] = [];

  parts.push(loadPromptFile("persona"));

  parts.push(`\n## Story Card\n`);
  parts.push(`**ID:** ${card.id}`);
  parts.push(`**Title:** ${card.title}`);
  if (card.stakeholder) parts.push(`**Stakeholder:** ${card.stakeholder}`);
  parts.push(`\n${card.description}`);

  if (card.acceptanceCriteria.length > 0) {
    parts.push(`\n## Acceptance Criteria`);
    for (const criterion of card.acceptanceCriteria) {
      parts.push(`- ${criterion}`);
    }
    parts.push(
      `\nEvaluate each criterion based on what you observe. Use your judgment.`
    );
  } else {
    parts.push(
      `\nThis story has no explicit acceptance criteria. You should explore the application freely and report what you find. Judge whether the story's intent is satisfied.`
    );
  }

  parts.push(`\n## Reporting

When you are done testing, call the \`report_result\` tool with your findings.

Your verdict should be:
- **pass** — the story's intent is satisfied, acceptance criteria met
- **fail** — something is clearly broken or criteria are not met
- **investigate** — you're unsure, something seems off but you can't confirm

Include ALL observations, not just those related to the acceptance criteria.`);

  // PRI-1439: web-only side-trip guidance. Other adapters (cli, tui)
  // don't have new_tab/close_tab and should not be told to use them.
  if (adapterName === "web") {
    parts.push(WEB_SIDE_TRIP_GUIDANCE);
  }

  // Context section — last block, only when populated. Spec §4.4.
  if (contextTree && contextTree.length > 0) {
    parts.push(
      "\n" + CONTEXT_SECTION_PROSE.replace("{{TREE_LISTING}}", contextTree),
    );
  }

  return parts.join("\n");
}
