import { mkdirSync, cpSync, readdirSync, statSync } from "fs";
import { join } from "path";

export interface SnapshotInputs {
  /** Absolute path to the run output directory (`.gauntlet/results/<runId>`). */
  runDir: string;
  /** Absolute path to the resolved story file. Copied to `<runDir>/inputs/story.md`. */
  storyPath: string;
  /**
   * Absolute path to the *source* context root (`.gauntlet/context/`). Copied
   * recursively to `<runDir>/inputs/context/`. If the source is missing or
   * empty, an empty `inputs/context/` is created — matching the existing
   * "degrade gracefully when no context is present" semantics.
   */
  contextRoot: string;
}

/**
 * Snapshot a run's inputs into `<runDir>/inputs/` so history views and future
 * resumed-chat sessions see the world as the agent saw it at run start.
 *
 * Also creates and seeds `<runDir>/scratch/` — the shell adapter's cwd — from
 * the same source context. Stories that ask the agent to `vim notes.md` find
 * `notes.md` in their cwd; the snapshot at `inputs/context/` stays untouched
 * and immutable for the read tool.
 *
 * Synchronous. Callers run this exactly once, before adapter construction.
 */
export function snapshotRunInputs(opts: SnapshotInputs): void {
  const inputsDir = join(opts.runDir, "inputs");
  mkdirSync(inputsDir, { recursive: true });

  cpSync(opts.storyPath, join(inputsDir, "story.md"));

  const destContext = join(inputsDir, "context");
  mkdirSync(destContext, { recursive: true });
  const populated = sourceIsPopulated(opts.contextRoot);
  if (populated) {
    cpSync(opts.contextRoot, destContext, { recursive: true });
  }

  // scratch is the shell adapter's cwd. Agent mutations land here; the run
  // dies with the directory. Structure mirrors source context exactly.
  const scratchDir = join(opts.runDir, "scratch");
  mkdirSync(scratchDir, { recursive: true });
  if (populated) {
    cpSync(opts.contextRoot, scratchDir, { recursive: true });
  }
}

function sourceIsPopulated(root: string): boolean {
  try {
    const stat = statSync(root);
    if (!stat.isDirectory()) return false;
    return readdirSync(root).length > 0;
  } catch (err) {
    // Only absence (ENOENT) or not-a-dir (ENOTDIR) degrade to "empty".
    // Permission errors etc. bubble up so the run fails loudly — spec §
    // "Failure handling" requires copy errors to surface before the
    // agent starts.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}
