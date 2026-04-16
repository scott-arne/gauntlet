import { join } from "path";

export const GAUNTLET_DIRNAME = ".gauntlet";

/**
 * Compose a path under the project's `.gauntlet/` state directory.
 * Centralizes the `.gauntlet/` convention so no call site hardcodes it.
 *
 *   gauntletPath(root, "stories")              → <root>/.gauntlet/stories
 *   gauntletPath(root, "results", runId)       → <root>/.gauntlet/results/<runId>
 *   gauntletPath(root, "context", user, "foo") → <root>/.gauntlet/context/<user>/foo
 */
export function gauntletPath(projectRoot: string, ...sub: string[]): string {
  return join(projectRoot, GAUNTLET_DIRNAME, ...sub);
}
