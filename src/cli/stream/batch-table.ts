import type { WriteSink } from "./jsonl";
import type { VetStatus } from "../../types";

interface CardRow {
  cardId: string;
  runId: string | null;
  state: "queued" | "running" | "done" | "errored";
  turn: number;
  maxTurns: number;
  finalStatus: VetStatus | null;
  errorTurn: number | null;
  errorMessage: string | null;
  startedAt: number;        // ms; 0 until setRunning
  finishedAt: number | null; // ms
}

export interface BatchTableOptions {
  isTTY: boolean;
  color: boolean;
  columns: number;
  /** Target URL surfaced in the TTY header; ignored in non-TTY mode. */
  target: string;
  /** Path to surface in the final summary so the user knows where evidence
   * landed (e.g., `<projectRoot>/.gauntlet/results`). batch.ts derives it
   * from `gauntletPath(config.projectRoot, "results")`. */
  resultsRoot: string;
}

const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// Inline ANSI byte sequences. Tiny + nowhere else in the tree to import them
// from; `pretty.ts` uses the same shape inline.
const ERASE_LINE = "\r\x1b[2K";              // CR + erase entire line
const CURSOR_UP_AND_ERASE = "\x1b[1A\r\x1b[2K"; // up one + CR + erase

const C = {
  reset: "\x1b[0m",
  dim:   "\x1b[2m",
  bold:  "\x1b[1m",
  green: "\x1b[32m",
  yellow:"\x1b[33m",
  red:   "\x1b[31m",
  cyan:  "\x1b[36m",
};

export class BatchTableRenderer {
  private rows = new Map<string, CardRow>();
  private order: string[] = [];

  // TTY-mode state
  private headerWritten = false;
  private activeCardId: string | null = null;
  private cardIndex = 0;            // 1-indexed; the currently-running card
  private spinnerStep = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  // True when setRunning wrote a "\n" above the current spinner — meaning
  // commit() needs to erase that blank line in addition to the spinner so
  // the next commit stacks flush against the previous one. False on the
  // very first card, whose blank-above is the header's own trailing blank
  // and should be preserved.
  private pendingBlankAboveSpinner = false;

  constructor(private sink: WriteSink, private opts: BatchTableOptions) {}

  setQueued(cardId: string): void {
    if (!this.rows.has(cardId)) this.order.push(cardId);
    this.rows.set(cardId, {
      cardId,
      runId: null,
      state: "queued",
      turn: 0,
      maxTurns: 0,
      finalStatus: null,
      errorTurn: null,
      errorMessage: null,
      startedAt: 0,
      finishedAt: null,
    });
    if (!this.opts.isTTY) this.sink.write(`${cardId}: queued\n`);
    // TTY: queued cards aren't shown until they start; the model is enough.
  }

  setRunning(cardId: string, runId: string, maxTurns: number): void {
    const row = this.rows.get(cardId);
    if (!row) return;
    row.runId = runId;
    row.state = "running";
    row.maxTurns = maxTurns;
    row.startedAt = Date.now();

    if (!this.opts.isTTY) {
      this.sink.write(`${cardId}: running turn 0 / ${maxTurns}\n`);
      return;
    }

    this.cardIndex += 1;
    this.activeCardId = cardId;
    if (!this.headerWritten) {
      // First card: header writes its own trailing blank, spinner sits
      // directly underneath. No "\n" added here.
      this.writeHeader();
    } else {
      // Subsequent cards: insert a blank line above the new spinner so
      // it visually separates from the previous commit. commit() will
      // erase this blank when the spinner becomes a result.
      this.sink.write("\n");
      this.pendingBlankAboveSpinner = true;
    }
    this.drawSpinner();
    this.startSpinnerTimer();
  }

  onTurn(cardId: string, turn: number): void {
    const row = this.rows.get(cardId);
    if (!row || row.state !== "running") return;
    row.turn = turn;
    if (!this.opts.isTTY) {
      this.sink.write(`${cardId}: running turn ${turn} / ${row.maxTurns}\n`);
      return;
    }
    if (this.activeCardId === cardId) this.drawSpinner();
  }

  setDone(cardId: string, finalStatus: VetStatus, turn: number): void {
    const row = this.rows.get(cardId);
    if (!row) return;
    row.state = "done";
    row.finalStatus = finalStatus;
    row.turn = turn;
    row.finishedAt = Date.now();

    if (!this.opts.isTTY) {
      this.sink.write(`${cardId}: done (${finalStatus}) on turn ${turn}\n`);
      return;
    }
    this.commit(row);
  }

  setErrored(cardId: string, turn: number | null, message: string): void {
    const row = this.rows.get(cardId);
    if (!row) return;
    // If the caller didn't pass a turn but the row was already running,
    // use the row's last-known turn. This way batch.ts can call
    // setErrored(cardId, null, msg) for any failure and the table picks
    // the right wording (`errored before start` vs `errored on turn N`).
    const wasRunning = row.state === "running";
    const effectiveTurn = turn ?? (wasRunning ? row.turn : null);
    row.state = "errored";
    row.errorTurn = effectiveTurn;
    row.errorMessage = message;
    row.finishedAt = Date.now();

    if (!this.opts.isTTY) {
      if (effectiveTurn === null) this.sink.write(`${cardId}: errored before start\n`);
      else this.sink.write(`${cardId}: errored on turn ${effectiveTurn}\n`);
      return;
    }
    this.commit(row);
  }

  finalize(): void {
    this.stopSpinnerTimer();
    if (this.opts.isTTY && this.activeCardId !== null) {
      // Defensive: a run that produces no terminal event would leak the
      // spinner line. Erase it so the summary sits cleanly.
      this.sink.write(ERASE_LINE);
      if (this.pendingBlankAboveSpinner) this.sink.write(CURSOR_UP_AND_ERASE);
      this.activeCardId = null;
      this.pendingBlankAboveSpinner = false;
    }

    let pass = 0, fail = 0, investigate = 0, errored = 0;
    for (const cardId of this.order) {
      const row = this.rows.get(cardId);
      if (!row) continue;
      if (row.state === "errored") errored++;
      else if (row.finalStatus === "pass") pass++;
      else if (row.finalStatus === "fail") fail++;
      else if (row.finalStatus === "investigate") investigate++;
    }
    this.sink.write(
      `\nbatch: ${pass} pass · ${fail} fail · ${investigate} investigate · ${errored} errored\n`,
    );
    this.sink.write(`results: ${this.opts.resultsRoot}\n`);
  }

  // ────────────────────────── TTY helpers ──────────────────────────

  private writeHeader(): void {
    const { target } = this.opts;
    const n = this.order.length;
    const c = this.colors();
    const cardsLabel = n === 1 ? "1 card" : `${n} cards`;
    this.sink.write(
      `${c.bold}Gauntlet${c.reset}${c.dim} · ${cardsLabel} · target ${c.reset}${c.cyan}${target}${c.reset}\n\n`,
    );
    this.headerWritten = true;
  }

  private drawSpinner(): void {
    const cardId = this.activeCardId;
    if (cardId === null) return;
    const row = this.rows.get(cardId);
    if (!row) return;
    const c = this.colors();
    const frame = SPINNER_FRAMES[this.spinnerStep % SPINNER_FRAMES.length];
    const idx = this.cardIndex;
    const total = this.order.length;
    const turn = row.turn === 0 && row.state === "running"
      ? `starting…`
      : `turn ${row.turn} / ${row.maxTurns}`;
    this.sink.write(
      `${ERASE_LINE}${c.bold}${frame}${c.reset} ${c.dim}[${idx}/${total}]${c.reset} ${cardId}   ${c.dim}${turn}${c.reset}`,
    );
  }

  private commit(row: CardRow): void {
    this.stopSpinnerTimer();
    if (!this.headerWritten) this.writeHeader();

    // If a spinner is currently on screen, erase it (and the blank line
    // above it, if we wrote one). The committed result then takes the
    // spinner's slot, stacking flush with the previous commit (or, for
    // the first card, sitting directly under the header's blank line).
    if (this.activeCardId !== null) {
      this.sink.write(ERASE_LINE);
      if (this.pendingBlankAboveSpinner) this.sink.write(CURSOR_UP_AND_ERASE);
      this.activeCardId = null;
      this.pendingBlankAboveSpinner = false;
    }
    // Else: parse-failure / setErrored before setRunning. Cursor is on
    // the blank line below the previous content (header trailing blank
    // for the very first card, or below the previous commit's hint
    // line). Either way, writing the result here lands it flush.

    const c = this.colors();
    const elapsedSec = row.finishedAt && row.startedAt
      ? ((row.finishedAt - row.startedAt) / 1000).toFixed(1)
      : "—";
    const turnsLabel = row.state === "errored"
      ? row.errorTurn === null ? "before start" : `turn ${row.errorTurn}`
      : `${row.turn} turns`;

    const glyph = this.glyphFor(row);
    const status = this.statusFor(row);
    const runHint = row.runId
      ? `${this.opts.resultsRoot}/${row.runId}/`
      : "—";

    this.sink.write(
      `  ${glyph} ${row.cardId}   ${status}   ${c.dim}${turnsLabel} · ${elapsedSec}s${c.reset}\n`,
    );
    this.sink.write(`        ${c.dim}→${c.reset} ${c.cyan}${runHint}${c.reset}\n`);
  }

  private glyphFor(row: CardRow): string {
    const c = this.colors();
    if (row.state === "errored") return `${c.red}✗${c.reset}`;
    switch (row.finalStatus) {
      case "pass":        return `${c.green}✓${c.reset}`;
      case "fail":        return `${c.red}✗${c.reset}`;
      case "investigate": return `${c.yellow}!${c.reset}`;
      default:            return ` `;
    }
  }

  private statusFor(row: CardRow): string {
    const c = this.colors();
    if (row.state === "errored") {
      const msg = row.errorMessage ? ` — ${row.errorMessage}` : "";
      return `${c.red}error${c.reset}${c.dim}${msg}${c.reset}`;
    }
    switch (row.finalStatus) {
      case "pass":        return `${c.green}pass${c.reset}`;
      case "fail":        return `${c.red}fail${c.reset}`;
      case "investigate": return `${c.yellow}investigate${c.reset}`;
      default:            return "";
    }
  }

  private startSpinnerTimer(): void {
    this.stopSpinnerTimer();
    this.spinnerTimer = setInterval(() => {
      this.spinnerStep += 1;
      this.drawSpinner();
    }, 80);
    // Don't keep the process alive solely for spinner ticks.
    (this.spinnerTimer as { unref?: () => void }).unref?.();
  }

  private stopSpinnerTimer(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private colors(): Record<keyof typeof C, string> {
    if (this.opts.color) return C;
    const blank: Record<string, string> = {};
    for (const k of Object.keys(C)) blank[k] = "";
    return blank as Record<keyof typeof C, string>;
  }
}
