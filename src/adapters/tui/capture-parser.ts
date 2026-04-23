import { Terminal } from "@xterm/headless";

/**
 * Parser-neutral seam between raw ANSI bytes captured from tmux and the
 * structured Cell grid the Web UI renders. The initial implementation
 * (XtermCaptureParser) is backed by @xterm/headless. A future
 * GhosttyCaptureParser will live behind this same interface so captures
 * can be parsed by either engine and compared for differential testing.
 *
 * The contract is async because @xterm/headless processes writes on a
 * microtask queue and its buffer only reflects the change after a
 * callback. Callers must `await` parse(). Ghostty's upcoming parser can
 * return a resolved promise if it runs synchronously — async here means
 * "at most one microtask of latency," not "slow."
 */
export interface CaptureParser {
  parse(ansi: string, cols: number, rows: number): Promise<Capture>;
}

/**
 * On-disk format for `captures/NNN.json`. Kept intentionally compact:
 * one run can produce many captures and the UI re-fetches them on
 * every render.
 */
export interface Capture {
  cols: number;
  rows: number;
  /** `cells[row][col]`. A row is always length `cols`. The second half of
   * a wide char is an empty-string cell with `width: 1`; the first half
   * holds the character and `width: 2`. */
  cells: Cell[][];
}

export interface Cell {
  /** UTF-8 codepoint(s). Empty string for the trailing half of a wide glyph. */
  ch: string;
  /** Hex color ("#rrggbb") or the 16 ANSI palette names. Omitted if default. */
  fg?: string;
  /** Hex color or palette name. Omitted if default. */
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** East Asian Width slot; 2 for wide glyphs, 1 otherwise. */
  width: 1 | 2;
}

/** 16-entry ANSI palette (0–7 normal, 8–15 bright). Hex values mirror the
 * tango-ish palette xterm itself ships — chosen for pleasant contrast on
 * both light and dark UI themes, not bit-exact to any specific terminal. */
const PALETTE_16: readonly string[] = [
  "#000000", // 0  black
  "#cd3131", // 1  red
  "#0dbc79", // 2  green
  "#e5e510", // 3  yellow
  "#2472c8", // 4  blue
  "#bc3fbc", // 5  magenta
  "#11a8cd", // 6  cyan
  "#e5e5e5", // 7  white
  "#666666", // 8  bright black
  "#f14c4c", // 9  bright red
  "#23d18b", // 10 bright green
  "#f5f543", // 11 bright yellow
  "#3b8eea", // 12 bright blue
  "#d670d6", // 13 bright magenta
  "#29b8db", // 14 bright cyan
  "#ffffff", // 15 bright white
];

function paletteColor(n: number): string | undefined {
  if (n < 0) return undefined;
  if (n < 16) return PALETTE_16[n];
  // 256-color: leave as hex string; xterm-256 palette mapping is well-known
  // but carrying the raw index keeps the JSON compact and lets the UI do
  // its own palette lookup if we ever want to. For now, render as "p<NNN>"
  // so the UI can treat it as "not styled" fallback.
  if (n < 256) return `p${n}`;
  return undefined;
}

function rgbHex(n: number): string {
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (
    "#" +
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0")
  );
}

export class XtermCaptureParser implements CaptureParser {
  async parse(ansi: string, cols: number, rows: number): Promise<Capture> {
    const term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 0,
    });
    // tmux's `capture-pane -e` emits one line per viewport row with `\n`
    // as the row separator. Streaming that directly into xterm treats
    // each `\n` as a cursor advance — if the capture has `rows` lines of
    // content (common), the final newlines scroll row 0 off the top of
    // a 0-scrollback terminal and we lose the content we wanted to
    // render. Feed each line with absolute cursor positioning instead:
    // for line i, jump to (i+1, 1), write the line bytes, let the next
    // iteration reposition for the next row. Colour state persists
    // across iterations because we never issue an SGR reset between
    // lines.
    const lines = ansi.split("\n");
    let seq = "";
    for (let i = 0; i < Math.min(lines.length, rows); i++) {
      // CSI y;1H — move cursor to row y (1-indexed), column 1.
      seq += `\x1b[${i + 1};1H` + lines[i];
    }
    await new Promise<void>((resolve) => term.write(seq, resolve));

    const buffer = term.buffer.active;
    const grid: Cell[][] = [];
    for (let y = 0; y < rows; y++) {
      const row: Cell[] = [];
      const line = buffer.getLine(y);
      if (!line) {
        for (let x = 0; x < cols; x++) row.push({ ch: " ", width: 1 });
        grid.push(row);
        continue;
      }
      for (let x = 0; x < cols; x++) {
        const raw = line.getCell(x);
        if (!raw) {
          row.push({ ch: " ", width: 1 });
          continue;
        }
        const width = raw.getWidth();
        // xterm reports width=0 for the trailing half of a wide glyph.
        // Surface that as an empty cell with width:1 — the UI spans
        // grid-column on the leading cell.
        if (width === 0) {
          row.push({ ch: "", width: 1 });
          continue;
        }
        const ch = raw.getChars() || " ";
        const cell: Cell = {
          ch,
          width: width === 2 ? 2 : 1,
        };
        // Foreground
        if (!raw.isFgDefault()) {
          if (raw.isFgRGB()) cell.fg = rgbHex(raw.getFgColor());
          else if (raw.isFgPalette()) {
            const c = paletteColor(raw.getFgColor());
            if (c) cell.fg = c;
          }
        }
        // Background
        if (!raw.isBgDefault()) {
          if (raw.isBgRGB()) cell.bg = rgbHex(raw.getBgColor());
          else if (raw.isBgPalette()) {
            const c = paletteColor(raw.getBgColor());
            if (c) cell.bg = c;
          }
        }
        if (raw.isBold()) cell.bold = true;
        if (raw.isItalic()) cell.italic = true;
        if (raw.isUnderline()) cell.underline = true;
        row.push(cell);
      }
      grid.push(row);
    }
    term.dispose();

    return { cols, rows, cells: grid };
  }
}

/**
 * Default parser instance. Parser choice is app-level config, not
 * per-run — this module is the single point of selection. When
 * GhosttyCaptureParser lands, flip the import here (or gate by config)
 * and every call site follows.
 */
export const defaultCaptureParser: CaptureParser = new XtermCaptureParser();
