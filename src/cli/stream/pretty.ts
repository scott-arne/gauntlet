import type { StreamEvent, StreamRenderer } from "./renderer";
import type { WriteSink } from "./jsonl";
import { makePaint, type Paint } from "./colors";

const RULE = "──────────────────────────────────────────────────────";

export interface PrettyOptions {
  color: boolean;
  columns: number;
}

export class PrettyRenderer implements StreamRenderer {
  private paint: Paint;
  private maxTurns: number | undefined;
  private runId: string | undefined;
  private model: string | undefined;

  constructor(private sink: WriteSink, private opts: PrettyOptions) {
    this.paint = makePaint(opts.color);
  }

  handle(event: StreamEvent): void {
    switch (event.type) {
      case "run_start":
        this.renderRunStart(event);
        return;
      case "run_end":
        this.renderRunEnd(event);
        return;
      default:
        return;
    }
  }

  close(): void {
    // nothing to flush yet
  }

  private write(line: string): void {
    this.sink.write(line + "\n");
  }

  private renderRunStart(e: StreamEvent): void {
    const p = this.paint;
    this.maxTurns = Number(e.maxTurns ?? 0);
    this.runId = String(e.runId ?? "");
    this.model = String(e.model ?? "");
    this.write(p.dim(RULE));
    this.write(`  ${p.dim("runId    ")} ${e.runId}`);
    this.write(`  ${p.dim("card     ")} ${e.cardId}`);
    this.write(`  ${p.dim("target   ")} ${e.target ?? "—"}`);
    this.write(`  ${p.dim("model    ")} ${e.model}`);
    this.write(`  ${p.dim("adapter  ")} ${e.adapter}`);
    this.write(`  ${p.dim("max turns")} ${e.maxTurns}`);
    this.write(p.dim(RULE));
    this.write("");
  }

  private renderRunEnd(e: StreamEvent): void {
    const p = this.paint;
    const status = String(e.status);
    const ok = status === "pass";
    const mark = ok ? p.green("✓") : p.red("✗");
    const statusTxt = ok ? p.green(status) : p.red(status);
    this.write(`${p.dim("─── Run complete ──────────────────────────────")} ${mark} ${statusTxt}`);
    this.write(`  ${p.dim("runId")}     ${this.runId ?? ""}`);
    this.write(`  ${p.dim("duration")}  ${formatDuration(Number(e.durationMs ?? 0))}`);
    const usage = e.usage as Record<string, number> | undefined;
    const turns = usage?.turns ?? 0;
    const max = this.maxTurns ?? "?";
    this.write(`  ${p.dim("turns")}     ${turns} / ${max}`);
    if (usage) {
      const parts = [
        `in ${formatThousands(usage.inputTokens)}`,
        `out ${formatThousands(usage.outputTokens)}`,
      ];
      if (usage.cacheReadInputTokens) parts.push(`cache ${formatThousands(usage.cacheReadInputTokens)}`);
      this.write(`  ${p.dim("usage")}     ${parts.join("  ")}`);
    }
    if (e.summary) this.write(`  ${p.dim("summary")}   ${e.summary}`);
  }
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(1)}s`;
}

function formatThousands(n: number | undefined): string {
  if (n === undefined) return "0";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
