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
}

export interface BatchTableOptions {
  isTTY: boolean;
  color: boolean;
  columns: number;
}

export class BatchTableRenderer {
  private rows = new Map<string, CardRow>();
  private order: string[] = [];
  private linesLastWritten = 0;

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
    });
    this.emitAppendLine(`${cardId}: queued`);
  }

  setRunning(cardId: string, runId: string, maxTurns: number): void {
    const row = this.rows.get(cardId);
    if (!row) return;
    row.runId = runId;
    row.state = "running";
    row.maxTurns = maxTurns;
    this.emitAppendLine(`${cardId}: running turn ${row.turn} / ${maxTurns}`);
  }

  onTurn(cardId: string, turn: number): void {
    const row = this.rows.get(cardId);
    if (!row || row.state !== "running") return;
    row.turn = turn;
    this.emitAppendLine(`${cardId}: running turn ${turn} / ${row.maxTurns}`);
  }

  setDone(cardId: string, finalStatus: VetStatus, turn: number): void {
    const row = this.rows.get(cardId);
    if (!row) return;
    row.state = "done";
    row.finalStatus = finalStatus;
    row.turn = turn;
    this.emitAppendLine(`${cardId}: done (${finalStatus}) on turn ${turn}`);
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
    if (effectiveTurn === null) this.emitAppendLine(`${cardId}: errored before start`);
    else this.emitAppendLine(`${cardId}: errored on turn ${effectiveTurn}`);
  }

  finalize(): void {
    if (this.opts.isTTY) this.redrawTTY();
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
  }

  private emitAppendLine(line: string): void {
    if (this.opts.isTTY) {
      this.redrawTTY();
      return;
    }
    this.sink.write(line + "\n");
  }

  private redrawTTY(): void {
    const frame = this.renderFrame();
    if (this.linesLastWritten > 0) {
      // Cursor up N lines, erase from there to end of screen.
      this.sink.write(`\x1b[${this.linesLastWritten}A\x1b[0J`);
    }
    this.sink.write(frame);
    this.linesLastWritten = frame.split("\n").length - 1; // trailing \n doesn't add a line
  }

  private renderFrame(): string {
    const header = "Gauntlet running in Batch Mode";
    const rule = "==============================";
    const idWidth = Math.max(...this.order.map((c) => c.length), 1);
    const lines: string[] = [header, rule];
    for (const cardId of this.order) {
      const row = this.rows.get(cardId);
      if (!row) continue;
      lines.push(`  ${cardId.padEnd(idWidth)}  ${this.statusText(row)}`);
    }
    return lines.join("\n") + "\n";
  }

  private statusText(row: CardRow): string {
    switch (row.state) {
      case "queued":
        return "(queued)";
      case "running":
        return `Running turn ${row.turn} / ${row.maxTurns}`;
      case "done":
        return `Complete on turn ${row.turn} / ${row.maxTurns}    ${row.finalStatus}`;
      case "errored":
        if (row.errorTurn === null) return "Errored before start    error";
        return `Errored on turn ${row.errorTurn}    error`;
      default: {
        const _exhaustive: never = row.state;
        throw new Error("unreachable: " + JSON.stringify(_exhaustive));
      }
    }
  }
}
