/**
 * Word-wrap `text` to `width` columns. Splits on whitespace; preserves
 * explicit newlines. Breaks a word mid-character only when that word
 * itself exceeds `width`.
 */
export function softWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= width) {
      out.push(rawLine);
      continue;
    }
    const words = rawLine.split(/\s+/);
    let line = "";
    for (const word of words) {
      if (!line) {
        if (word.length > width) {
          // Word too long to fit — hard-break it
          let remaining = word;
          while (remaining.length > width) {
            out.push(remaining.slice(0, width));
            remaining = remaining.slice(width);
          }
          line = remaining;
        } else {
          line = word;
        }
        continue;
      }
      if (line.length + 1 + word.length <= width) {
        line += " " + word;
      } else {
        out.push(line);
        if (word.length > width) {
          // Word too long to fit — hard-break it
          let remaining = word;
          while (remaining.length > width) {
            out.push(remaining.slice(0, width));
            remaining = remaining.slice(width);
          }
          line = remaining;
        } else {
          line = word;
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Truncate a stringified tool-call args blob at `limit` characters,
 * replacing the tail with a `… (+N more)` marker counting remaining bytes.
 */
export function truncateArgs(s: string, limit: number): string {
  if (s.length <= limit) return s;
  const remaining = s.length - limit;
  return `${s.slice(0, limit)}… (+${remaining} more)`;
}
