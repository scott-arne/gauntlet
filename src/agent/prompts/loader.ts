import { readFileSync } from "fs";
import { join } from "path";

/**
 * Read a prompt file from src/agent/prompts/<name>.md. Trims trailing
 * whitespace (so .md files can end with a trailing newline without
 * breaking the \n\n joiner). A zero-byte file is valid and returns "".
 * A missing file throws with the resolved path.
 *
 * Resolution uses import.meta.dir so the loader works under bun run,
 * bun build, and `bun build --compile` standalone binaries.
 */
export function loadPromptFile(name: string): string {
  const path = join(import.meta.dir, `${name}.md`);
  try {
    const raw = readFileSync(path, "utf-8");
    return raw.replace(/\s+$/, "");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Required prompt file not found: ${path}`);
    }
    throw err;
  }
}
