import type { StreamEvent, StreamRenderer } from "./renderer";
import type { WriteSink } from "./jsonl";
import { makePaint, type Paint } from "./colors";
import { softWrap, truncateArgs } from "./wrap";

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
      case "llm_response":
        this.renderLlmResponse(event);
        return;
      case "tool_call":
        this.renderToolCall(event);
        return;
      case "tool_result":
        this.renderToolResult(event);
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

  private renderLlmResponse(e: StreamEvent): void {
    const p = this.paint;
    const turn = Number(e.turn ?? 0);
    // Model is cached from run_start. No leading blank here — the preceding
    // section (run_start or tool_result) emits its own trailing blank.
    const modelLabel = this.model ?? "";
    const maxTurnsStr = this.maxTurns ?? "?";
    const header = `${p.cyan("▎")} ${p.bold(`Turn ${turn}`)} ${p.dim(`· ${modelLabel} · turn ${turn} / ${maxTurnsStr}`)}`;
    this.write(header);

    const thinking = (e.thinking ?? []) as Array<{ text: string }>;
    for (const th of thinking) {
      this.write("");
      this.write(`  ${p.magenta("~ thinking")}`);
      for (const line of softWrap(th.text, this.opts.columns - 4)) {
        this.write(`    ${p.dim(line)}`);
      }
    }

    const text = String(e.text ?? "");
    if (text.length > 0) {
      this.write("");
      this.write(`  ${p.yellow("= assistant")}`);
      for (const line of softWrap(text, this.opts.columns - 4)) {
        this.write(`    ${line}`);
      }
    }
    this.write("");
  }

  private renderToolCall(e: StreamEvent): void {
    const p = this.paint;
    const name = String(e.name ?? "");
    const args = truncateArgs(JSON.stringify(e.arguments ?? {}), 200);
    this.write(`  ${p.cyan("▸")} ${p.bold(name)} ${p.dim(args)}`);
  }

  private renderToolResult(e: StreamEvent): void {
    const p = this.paint;
    const ms = Number(e.durationMs ?? 0);
    const err = Boolean(e.error);
    const timing = `${ms}ms`;
    if (err) {
      this.write(`    ${p.dim("↳")} ${p.red("✗")} ${p.dim(timing)}`);
      const text = String(e.text ?? "");
      if (text) this.write(`      ${p.dim("╵ error ")} ${text}`);
      if (e.hint) this.write(`      ${p.dim("╵ hint  ")} ${String(e.hint)}`);
    } else {
      this.write(`    ${p.dim("↳")} ${p.green("✓")} ${p.dim(timing)}`);
      if (e.image)            this.write(`      ${p.dim("→")} ${p.blue(String(e.image))}`);
      else if (e.artifact)    this.write(`      ${p.dim("→")} ${p.blue(String(e.artifact))}`);
      else if (e.capturePath) this.write(`      ${p.dim("→")} ${p.blue(String(e.capturePath))}`);
    }
    this.write("");
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
