import personaText from "./persona.md" with { type: "text" };
import evaluationText from "./evaluation.md" with { type: "text" };
import contextText from "./context.md" with { type: "text" };
import adapterWebText from "./adapter-web.md" with { type: "text" };
import adapterCliText from "./adapter-cli.md" with { type: "text" };
import adapterTuiText from "./adapter-tui.md" with { type: "text" };
import stuckHandlingText from "./stuck-handling.md" with { type: "text" };

const FILES: Record<string, string> = {
  "persona": personaText,
  "evaluation": evaluationText,
  "context": contextText,
  "adapter-web": adapterWebText,
  "adapter-cli": adapterCliText,
  "adapter-tui": adapterTuiText,
  "stuck-handling": stuckHandlingText,
};

/**
 * Return the text of a prompt file by name (no `.md` extension).
 * Trims trailing whitespace so .md files can end with a trailing newline
 * without breaking the \n\n joiner. A zero-byte file is valid and returns "".
 * An unknown name throws.
 *
 * Files are bundled at build time via `with { type: "text" }` imports, so
 * the loader works identically under `bun run`, `bun build`, and
 * `bun build --compile` standalone binaries — no runtime fs access.
 */
export function loadPromptFile(name: string): string {
  const text = FILES[name];
  if (text === undefined) {
    throw new Error(`Required prompt file not found: ${name}.md`);
  }
  return text.replace(/\s+$/, "");
}

/**
 * Names of all bundled prompt files. Exposed for tests and tooling that
 * want to enumerate the prompt surface.
 */
export const BUNDLED_PROMPT_NAMES: readonly string[] = Object.keys(FILES);
