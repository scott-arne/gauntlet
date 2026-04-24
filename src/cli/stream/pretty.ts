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
  private outDir: string | undefined;
  private pendingRewrite: { base: string } | undefined;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private spinnerStartMs = 0;
  private spinnerActive = false;

  constructor(private sink: WriteSink, private opts: PrettyOptions) {
    this.paint = makePaint(opts.color);
  }

  handle(event: StreamEvent): void {
    if (this.spinnerActive && event.type !== "llm_request") {
      this.clearSpinner();
    }
    // An interleaved event would invalidate the cursor-up+erase contract
    // of the pending tool_call line (we'd erase the wrong line). Drop the
    // pending state — the eventual tool_result falls through to the
    // two-line path and the stale `⋯` stays on the call line. The agent
    // loop today never interleaves other events between a call and its
    // result, but this guard keeps the renderer safe if that ever changes.
    if (this.pendingRewrite && event.type !== "tool_result") {
      this.pendingRewrite = undefined;
    }
    switch (event.type) {
      case "run_start":
        this.renderRunStart(event);
        return;
      case "llm_request":
        if (this.opts.color) this.startSpinner();
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
      case "event":
        if (event.name === "run_error") this.renderRunError(event);
        else this.renderEventMeta(event);
        return;
      case "run_end":
        this.renderRunEnd(event);
        return;
      default:
        return;
    }
  }

  close(): void {
    if (this.spinnerActive) this.clearSpinner();
  }

  private write(line: string): void {
    this.sink.write(line + "\n");
  }

  private renderRunStart(e: StreamEvent): void {
    const p = this.paint;
    this.maxTurns = Number(e.maxTurns ?? 0);
    this.runId = String(e.runId ?? "");
    this.model = String(e.model ?? "");
    this.outDir = e.outDir ? String(e.outDir) : undefined;
    const adapterLine = e.viewport
      ? `${e.adapter} · viewport ${String(e.viewport).replace("x", "×")}`
      : String(e.adapter);
    this.write(p.dim(RULE));
    this.write(`  ${p.dim("runId    ")} ${e.runId}`);
    this.write(`  ${p.dim("card     ")} ${e.cardId}`);
    this.write(`  ${p.dim("target   ")} ${e.target ?? "—"}`);
    this.write(`  ${p.dim("model    ")} ${e.model}`);
    this.write(`  ${p.dim("adapter  ")} ${adapterLine}`);
    this.write(`  ${p.dim("max turns")} ${e.maxTurns}`);
    if (this.outDir) this.write(`  ${p.dim("evidence ")} ${this.outDir}`);
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
    const evidence = e.outDir ? String(e.outDir) : this.outDir;
    if (evidence) this.write(`  ${p.dim("evidence")}  ${evidence}`);
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
    const base = `  ${p.cyan("▸")} ${p.bold(name)} ${p.dim(args)}`;
    if (this.opts.color) {
      // Inline-rewrite path: include a trailing pending marker so the user sees progress.
      this.write(`${base} ${p.dim("⋯")}`);
      this.pendingRewrite = { base };
    } else {
      this.write(base);
      this.pendingRewrite = undefined;
    }
  }

  private renderToolResult(e: StreamEvent): void {
    const p = this.paint;
    const ms = Number(e.durationMs ?? 0);
    const err = Boolean(e.error);
    const timing = `${ms}ms`;

    if (this.pendingRewrite && this.opts.color) {
      // Erase the previous line and rewrite with the final timing inline.
      const mark = err ? p.red("✗") : p.green("✓");
      this.sink.write("\x1b[1A\x1b[2K"); // cursor up, erase line
      this.write(`${this.pendingRewrite.base}   ${mark} ${p.dim(timing)}`);
      this.pendingRewrite = undefined;
    } else {
      // Two-line fallback — same as the existing no-color path.
      if (err) this.write(`    ${p.dim("↳")} ${p.red("✗")} ${p.dim(timing)}`);
      else     this.write(`    ${p.dim("↳")} ${p.green("✓")} ${p.dim(timing)}`);
    }

    // Secondary lines always print as a separate indented line regardless of mode.
    if (err) {
      const text = String(e.text ?? "");
      if (text) this.write(`      ${p.dim("╵ error ")} ${text}`);
      if (e.hint) this.write(`      ${p.dim("╵ hint  ")} ${String(e.hint)}`);
    } else {
      if (e.image)            this.write(`      ${p.dim("→")} ${p.blue(String(e.image))}`);
      else if (e.artifact)    this.write(`      ${p.dim("→")} ${p.blue(String(e.artifact))}`);
      else if (e.capturePath) this.write(`      ${p.dim("→")} ${p.blue(String(e.capturePath))}`);
    }
    this.write(""); // trailing blank — matches the non-color path
  }

  private renderEventMeta(e: StreamEvent): void {
    const p = this.paint;
    const { type: _t, eventId: _id, parentEventId: _pid, ts: _ts, name, ...rest } = e;
    const parts = Object.entries(rest)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    this.write(`  ${p.dim(`· ${name} ${parts.join(" ")}`)}`);
  }

  private renderRunError(e: StreamEvent): void {
    const p = this.paint;
    const turn = Number(e.turn ?? 0);
    this.write("");
    this.write(`${p.dim("─── Run failed ──────────────────────────────────")} ${p.red("✗")} ${p.red("error")}`);
    this.write(`  ${p.dim("runId")}     ${this.runId ?? ""}`);
    this.write(`  ${p.dim("turn")}      ${turn} / ${this.maxTurns ?? "?"}`);
    this.write(`  ${p.dim("error")}     ${String(e.message ?? "")}`);
  }

  private startSpinner(): void {
    this.spinnerActive = true;
    this.spinnerStartMs = Date.now();
    this.renderSpinnerLine();
    this.spinnerTimer = setInterval(() => this.renderSpinnerLine(), 1000);
  }

  private clearSpinner(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
    this.spinnerActive = false;
    this.sink.write("\r\x1b[2K");
  }

  private renderSpinnerLine(): void {
    const elapsed = Math.floor((Date.now() - this.spinnerStartMs) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    this.sink.write(`\r\x1b[2K${this.paint.dim(`⋯ waiting for model · ${mm}:${ss}`)}`);
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
