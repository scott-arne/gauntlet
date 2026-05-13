/**
 * Top-level CLI error rendering. Used by `src/index.ts` to format any
 * error that escapes a command body — file-not-found, malformed cards,
 * sanitized LLM errors (`LlmError`), config errors, etc.
 *
 * Output contract:
 *   - When `isTty` is true (stderr attached to a terminal), output is
 *     plain prose — humans don't want to read a JSON envelope. With
 *     `--verbose` or `GAUNTLET_DEBUG=1`, a stack trace follows.
 *   - When `isTty` is false (stderr piped to a file or another process),
 *     output is the JSON envelope `{ error: { message, code? } }` so
 *     programmatic consumers (CI scripts, the web UI shell-out path)
 *     parse stderr predictably.
 *   - Exit code is always 1 (set by the caller).
 */
export interface FormatCliErrorOptions {
  verbose: boolean;
  /**
   * True when stderr is a TTY. Production callers pass
   * `process.stderr.isTTY`. Defaults to false so piped/server paths
   * keep the parseable JSON envelope.
   */
  isTty?: boolean;
}

export function formatCliError(err: unknown, opts: FormatCliErrorOptions): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = readCode(err);

  let out: string;
  if (opts.isTty) {
    // Prose for humans. The errno code is already implied by the prose
    // message in practice (e.g. "ENOENT: no such file") — skip the
    // structured form.
    out = message.endsWith("\n") ? message : message + "\n";
  } else {
    const envelope = code !== undefined ? { error: { message, code } } : { error: { message } };
    out = JSON.stringify(envelope) + "\n";
  }

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
