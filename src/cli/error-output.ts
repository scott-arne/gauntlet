/**
 * Top-level CLI error rendering. Used by `src/index.ts` to format any
 * error that escapes a command body — file-not-found, malformed cards,
 * sanitized LLM errors (`LlmError`), config errors, etc.
 *
 * Output contract:
 *   - First stderr line is a JSON envelope: `{ error: { message, code? } }`
 *   - With `--verbose` or `GAUNTLET_DEBUG=1`, the stack trace follows on
 *     subsequent lines.
 *   - Exit code is always 1 (set by the caller).
 *
 * Why JSON-by-default: programmatic consumers (CI scripts, the web UI's
 * shell-out path, dashboards) parse stderr predictably without the
 * platform-dependent vagaries of Bun's unhandled-rejection printer. Humans
 * still see one short legible line.
 */
export interface FormatCliErrorOptions {
  verbose: boolean;
}

export function formatCliError(err: unknown, opts: FormatCliErrorOptions): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = readCode(err);
  const envelope = code !== undefined ? { error: { message, code } } : { error: { message } };

  let out = JSON.stringify(envelope) + "\n";
  if (opts.verbose && err instanceof Error && typeof err.stack === "string") {
    out += err.stack + "\n";
  }
  return out;
}

/**
 * `--verbose` (anywhere in argv) or `GAUNTLET_DEBUG=1` (env) enables stack
 * traces on top-level errors. The flag is read directly from process.argv
 * so it works even when arg parsing itself failed (e.g. an unknown command
 * or invalid flag value crashed `parseArgs` before we knew which command
 * was running).
 */
export function isVerboseRequest(env: Record<string, string | undefined>, argv: string[]): boolean {
  if (env.GAUNTLET_DEBUG === "1") return true;
  if (argv.includes("--verbose")) return true;
  return false;
}

function readCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const c = (err as Record<string, unknown>).code;
  return typeof c === "string" ? c : undefined;
}
