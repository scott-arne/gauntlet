/**
 * Parse a duration string into milliseconds.
 *
 * Accepted forms:
 *   "300"   → 300_000 (bare integer = seconds)
 *   "500ms" → 500
 *   "90s"   → 90_000
 *   "5m"    → 300_000
 *   "1h"    → 3_600_000
 *
 * Throws on:
 *   - empty / whitespace-only input
 *   - non-integer values (e.g. "1.5m")
 *   - zero or negative values
 *   - unknown suffixes
 *   - trailing garbage
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error(`invalid duration "${input}": empty`);
  }

  const match = /^(\d+)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `invalid duration "${input}": expected integer with optional suffix ms|s|m|h`,
    );
  }

  const n = parseInt(match[1]!, 10);
  if (n <= 0) {
    throw new Error(`invalid duration "${input}": must be positive`);
  }

  const unit = match[2] ?? "s";
  switch (unit) {
    case "ms": return n;
    case "s":  return n * 1_000;
    case "m":  return n * 60_000;
    case "h":  return n * 3_600_000;
  }

  // Unreachable: the regex restricts to ms|s|m|h|absent.
  throw new Error(`invalid duration "${input}": unknown unit`);
}
