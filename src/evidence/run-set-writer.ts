import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { RunSetCtx, SetBucket } from "../runs/run-set-types";
import { deriveBucket, median } from "../runs/aggregate";
import type { VetResult, VetStatus } from "../types";

interface RunEntry {
  runId: string;
  cardId: string;
  attemptNumber: number;
  status: "queued" | "running" | "cancelled" | VetStatus | "errored";
}

interface CardSummary {
  cardId: string;
  passes: number;
  byStatus: { pass: number; fail: number; investigate: number; errored: number; cancelled: number };
  cardStatus: SetBucket;
  medianTurns: number;
  medianDurationMs: number;
}

interface OverallSummary {
  totalRuns: number;
  byStatus: { pass: number; fail: number; investigate: number; errored: number; cancelled: number };
  overallStatus: SetBucket;
}

interface SetManifest {
  schemaVersion: 1;
  runSetId: string;
  kind: "single" | "batch";
  createdAt: string;
  completedAt: string | null;
  passes: number;
  cards: string[];
  runs: RunEntry[];
  summary: { perCard: CardSummary[]; overall: OverallSummary } | null;
}

export class RunSetWriter {
  private dir: string;
  private manifest!: SetManifest;

  constructor(private resultsRoot: string, private ctx: RunSetCtx) {
    this.dir = join(resultsRoot, "run-sets", ctx.runSetId);
  }

  start(allRuns: Array<{ runId: string; cardId: string; attemptNumber: number }>): void {
    mkdirSync(this.dir, { recursive: true });
    this.manifest = {
      schemaVersion: 1,
      runSetId: this.ctx.runSetId,
      kind: this.ctx.kind,
      createdAt: new Date().toISOString(),
      completedAt: null,
      passes: this.ctx.passes,
      cards: this.ctx.cards,
      runs: allRuns.map((r) => ({ ...r, status: "queued" as const })),
      summary: null,
    };
    this.flush();
  }

  recordRunStart(runId: string): void {
    const r = this.manifest.runs.find((x) => x.runId === runId);
    if (r) r.status = "running";
    this.flush();
  }

  recordRunEnd(runId: string, status: VetStatus | "errored" | "cancelled"): void {
    const r = this.manifest.runs.find((x) => x.runId === runId);
    if (r) r.status = status;
    this.flush();
  }

  finalize(lookup: (runId: string) => VetResult | null): void {
    // Track which run IDs had results provided via lookup (vs explicitly errored/cancelled)
    const processedIds = new Set<string>();
    for (const run of this.manifest.runs) {
      if (run.status !== "queued" && run.status !== "running" && run.status !== "cancelled" && run.status !== "errored") {
        processedIds.add(run.runId);
      }
    }

    const perCard: CardSummary[] = this.ctx.cards.map((cardId) => {
      const cardRuns = this.manifest.runs.filter((r) => r.cardId === cardId);
      return summarizeCard(cardId, cardRuns, lookup);
    });
    const overall = summarizeOverall(perCard);
    this.manifest.summary = { perCard, overall };
    this.manifest.completedAt = new Date().toISOString();
    this.flush();
    writeFileSync(join(this.dir, "summary.md"), renderSummaryMarkdown(this.manifest), "utf8");
  }

  private flush(): void {
    writeFileSync(join(this.dir, "set.json"), JSON.stringify(this.manifest, null, 2), "utf8");
  }
}

function summarizeCard(
  cardId: string,
  cardRuns: RunEntry[],
  lookup: (runId: string) => VetResult | null,
): CardSummary {
  const byStatus = { pass: 0, fail: 0, investigate: 0, errored: 0, cancelled: 0 };
  const turns: number[] = [];
  const durations: number[] = [];

  for (const r of cardRuns) {
    if (r.status === "cancelled") {
      byStatus.cancelled++;
      continue;
    }
    if (r.status === "errored") {
      byStatus.errored++;
      // PRI-1507: v5 errored runs (e.g. interrupted by shutdown drain)
      // can still carry partial usage data in their result.json — the
      // agent loop accumulates turns/tokens until the abort check fires.
      // Include those samples in medians. Catch-path errored entries
      // (lookup returns null, e.g. executor threw before producing a
      // result file) preserve today's behavior of skipping medians.
      const result = lookup(r.runId);
      if (result) {
        if (result.usage?.turns != null) turns.push(result.usage.turns);
        if (result.duration_ms != null) durations.push(result.duration_ms);
      }
      continue;
    }

    // For queued/running runs, or runs with a VetStatus, use the lookup to get the result.
    // If lookup returns null the run is treated as errored (failed to produce a result).
    const result = lookup(r.runId);
    if (r.status === "queued" || r.status === "running") {
      // Run never completed — treat as errored unless lookup provides a result
      if (result) {
        byStatus[result.status]++;
        if (result.usage?.turns != null) turns.push(result.usage.turns);
        if (result.duration_ms != null) durations.push(result.duration_ms);
      } else {
        byStatus.errored++;
      }
      continue;
    }
    // r.status is a VetStatus: pass | fail | investigate
    byStatus[r.status]++;
    if (result) {
      if (result.usage?.turns != null) turns.push(result.usage.turns);
      if (result.duration_ms != null) durations.push(result.duration_ms);
    }
  }

  return {
    cardId,
    passes: cardRuns.length,
    byStatus,
    cardStatus: deriveBucket(byStatus),
    medianTurns: median(turns),
    medianDurationMs: median(durations),
  };
}

function summarizeOverall(perCard: CardSummary[]): OverallSummary {
  const byStatus = { pass: 0, fail: 0, investigate: 0, errored: 0, cancelled: 0 };
  for (const c of perCard) {
    byStatus.pass += c.byStatus.pass;
    byStatus.fail += c.byStatus.fail;
    byStatus.investigate += c.byStatus.investigate;
    byStatus.errored += c.byStatus.errored;
    byStatus.cancelled += c.byStatus.cancelled;
  }
  return {
    totalRuns: byStatus.pass + byStatus.fail + byStatus.investigate + byStatus.errored + byStatus.cancelled,
    byStatus,
    overallStatus: deriveBucket(byStatus),
  };
}

function renderSummaryMarkdown(m: SetManifest): string {
  const lines: string[] = [];
  lines.push(`# Run set ${m.runSetId}`);
  lines.push("");
  lines.push(`- kind: ${m.kind}`);
  lines.push(`- passes: ${m.passes}`);
  lines.push(`- cards: ${m.cards.join(", ")}`);
  lines.push(`- created: ${m.createdAt}`);
  if (m.completedAt) lines.push(`- completed: ${m.completedAt}`);
  if (m.summary) {
    lines.push("");
    lines.push(`## Overall: ${m.summary.overall.overallStatus}`);
    for (const c of m.summary.perCard) {
      lines.push("");
      lines.push(`### ${c.cardId}: ${c.cardStatus}`);
      lines.push(`- byStatus: ${JSON.stringify(c.byStatus)}`);
      lines.push(`- median turns: ${c.medianTurns}`);
      lines.push(`- median duration_ms: ${c.medianDurationMs}`);
    }
  }
  return lines.join("\n") + "\n";
}
