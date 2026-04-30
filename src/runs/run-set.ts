import { readFileSync } from "fs";
import { RunSetWriter } from "../evidence/run-set-writer";
import { makeRunSetId, makeRunId } from "../util/id";
import type { RunSetCtx, RunSetKind } from "./run-set-types";
import type { VetResult } from "../types";

export interface ExecutorArgs {
  cardId: string;
  runSetCtx: RunSetCtx;
  runId: string;
}

export interface ExecutorReturn {
  runId: string;
  outDir: string;
  result: VetResult;
}

export type Executor = (args: ExecutorArgs) => Promise<ExecutorReturn>;

export interface CancelToken {
  cancelled: boolean;
}

export interface RunSetConfig {
  resultsRoot: string;
  cards: string[];
  passes: number;
  kind: RunSetKind;
  executor: Executor;
  generateRunId?: (cardId: string, attemptNumber: number) => string;
  cancelToken?: CancelToken;
  onAllRunsKnown?: (runs: Array<{ runId: string; cardId: string; attemptNumber: number }>) => void;
}

export interface RunSetResult {
  runSetId: string;
  runs: Array<{ runId: string; cardId: string; attemptNumber: number; status: string }>;
  summary: {
    perCard: Array<{ cardId: string; cardStatus: string; byStatus: Record<string, number> }>;
    overall: { overallStatus: string; byStatus: Record<string, number>; totalRuns: number };
  } | null;
}

export async function runRunSet(cfg: RunSetConfig): Promise<RunSetResult> {
  const runSetId = makeRunSetId(cfg.kind);
  const gen = cfg.generateRunId ?? ((cardId, _i) => makeRunId(cardId));

  // Eagerly generate all runIds so set.json is fully populated up front.
  const allRuns: Array<{ runId: string; cardId: string; attemptNumber: number }> = [];
  for (let cardIndex = 0; cardIndex < cfg.cards.length; cardIndex++) {
    for (let attemptNumber = 1; attemptNumber <= cfg.passes; attemptNumber++) {
      allRuns.push({
        runId: gen(cfg.cards[cardIndex], attemptNumber),
        cardId: cfg.cards[cardIndex],
        attemptNumber,
      });
    }
  }
  cfg.onAllRunsKnown?.(allRuns);

  const ctx0: RunSetCtx = {
    runSetId,
    kind: cfg.kind,
    passes: cfg.passes,
    cards: cfg.cards,
    cardIndex: 0,
    attemptNumber: 1,
  };
  const writer = new RunSetWriter(cfg.resultsRoot, ctx0);
  writer.start(allRuns);

  const resultsByRunId = new Map<string, VetResult>();
  const processedRunIds = new Set<string>();

  outer: for (let cardIndex = 0; cardIndex < cfg.cards.length; cardIndex++) {
    for (let attemptNumber = 1; attemptNumber <= cfg.passes; attemptNumber++) {
      if (cfg.cancelToken?.cancelled) break outer;

      const runEntry = allRuns.find(
        (r) => r.cardId === cfg.cards[cardIndex] && r.attemptNumber === attemptNumber,
      )!;
      const ctx: RunSetCtx = { ...ctx0, cardIndex, attemptNumber };

      writer.recordRunStart(runEntry.runId);
      processedRunIds.add(runEntry.runId);
      try {
        const ret = await cfg.executor({
          cardId: cfg.cards[cardIndex],
          runSetCtx: ctx,
          runId: runEntry.runId,
        });
        resultsByRunId.set(runEntry.runId, ret.result);
        writer.recordRunEnd(runEntry.runId, ret.result.status);
      } catch (_e) {
        writer.recordRunEnd(runEntry.runId, "errored");
      }
    }
  }

  // Anything we never started is `cancelled`.
  if (cfg.cancelToken?.cancelled) {
    for (const r of allRuns) {
      if (!processedRunIds.has(r.runId)) {
        writer.recordRunEnd(r.runId, "cancelled");
      }
    }
  }

  writer.finalize((runId) => resultsByRunId.get(runId) ?? null);

  // Re-read final manifest.
  const set = JSON.parse(
    readFileSync(`${cfg.resultsRoot}/run-sets/${runSetId}/set.json`, "utf8"),
  );
  return { runSetId, runs: set.runs, summary: set.summary };
}
