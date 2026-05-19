import { basename, extname } from "path";
import type { AppConfig } from "../config";
import type { EvidenceLogger, EventObserver } from "../evidence/logger";
import type { LLMClient } from "../models/provider";
import { gauntletPath } from "../paths";
import { runOne, type RunOneOptions, type RunOneSummary } from "./run-one";
import { runRunSet } from "../runs/run-set";
import { installSigintHandler } from "./signals";
import type { RunSetCtx } from "../runs/run-set-types";
import { BatchTableRenderer } from "./stream/batch-table";
import type { WriteSink } from "./stream/jsonl";
import { asCardId, type CardId } from "../util/brands";

export interface BatchOptions {
  scenarioPaths: string[];
  target: string;
  adapterType: RunOneOptions["adapterType"];
  config: AppConfig;
  silent: boolean;
  format: "pretty" | "jsonl" | undefined;
  noColor: boolean;
  sink: WriteSink;
  isTTY: boolean;
  passes: number;
  /** Test seam — see PRI-1505. Production callers leave this undefined; the
   * runOne calls below thread it through so tests don't need mock.module. */
  clientFactory?: (model: string) => LLMClient;
}

type RunOneFn = (opts: RunOneOptions) => Promise<RunOneSummary>;

function cardIdForPath(p: string): CardId {
  // v1: filename stem is the row identifier. Stable for queued rows
  // (no parse needed) and for parse-failure rows.
  return asCardId(basename(p, extname(p)));
}

function makeBatchObserver(
  table: BatchTableRenderer | null,
  format: "pretty" | "jsonl" | undefined,
  silent: boolean,
  sink: WriteSink,
  cardId: string,
  runSetCtx: RunSetCtx,
): (logger: EvidenceLogger) => () => void {
  const { attemptNumber, passes } = runSetCtx;
  return (logger: EvidenceLogger) => {
    let currentRunId: string | null = null;
    const observer: EventObserver = (ev) => {
      const t = ev.type as string;
      if (t === "run_start") {
        currentRunId = String((ev as any).runId);
        if (table) {
          table.setRunning(
            cardId,
            currentRunId,
            attemptNumber,
            passes,
          );
        }
      } else if (t === "llm_response") {
        if (table) table.onTurn(cardId, Number((ev as any).turn ?? 0), attemptNumber);
      } else if (t === "run_end") {
        const status = String((ev as any).status ?? "fail") as "pass" | "fail" | "investigate";
        const turns = Number(((ev as any).usage?.turns) ?? 0);
        if (table) table.setDone(cardId, status, turns, attemptNumber);
      }

      if (format === "jsonl" && !silent) {
        const enriched = { runId: currentRunId, ...ev };
        sink.write(JSON.stringify(enriched) + "\n");
      }
    };
    return logger.addEventObserver(observer);
  };
}

export async function runBatch(
  opts: BatchOptions,
  runOneImpl: RunOneFn = runOne,
): Promise<number> {
  const cards = opts.scenarioPaths.map((p) => ({ scenarioPath: p, id: cardIdForPath(p) }));
  const resultsRoot = gauntletPath(opts.config.projectRoot, opts.config.stateDirName, "results");
  const useTable = !opts.silent && opts.format !== "jsonl";
  const table = useTable
    ? new BatchTableRenderer(opts.sink, {
        isTTY: opts.isTTY,
        color: !opts.noColor && opts.isTTY,
        columns: 100,
        target: opts.target,
        resultsRoot,
      })
    : null;

  const cardIds = cards.map((c) => c.id);
  const useRunSet = opts.passes > 1 || cardIds.length > 1;

  if (useRunSet) {
    // Pre-queue all (cardId, attemptNumber) pairs via onAllRunsKnown.
    const onAllRunsKnown = (
      runs: Array<{ runId: string; cardId: string; attemptNumber: number }>,
    ) => {
      if (table) {
        for (const r of runs) {
          table.setQueued(r.cardId, r.attemptNumber, opts.passes);
        }
      }
    };

    // The state dir is the parent of both results/ and run-sets/.
    const gauntletRoot = gauntletPath(opts.config.projectRoot, opts.config.stateDirName);

    const cancelToken = { cancelled: false };
    const detach = installSigintHandler(cancelToken);
    let setResult;
    try {
      const handle = await runRunSet({
        resultsRoot: gauntletRoot,
        cards: cardIds,
        passes: opts.passes,
        kind: "batch",
        onAllRunsKnown,
        cancelToken,
        executor: async ({ cardId, runSetCtx, runId }) => {
          const card = cards.find((c) => c.id === cardId)!;
          const onLogger = makeBatchObserver(
            table,
            opts.format,
            opts.silent,
            opts.sink,
            cardId,
            runSetCtx,
          );
          try {
            return await runOneImpl({
              scenarioPath: card.scenarioPath,
              target: opts.target,
              adapterType: opts.adapterType,
              config: opts.config,
              onLogger,
              runSetCtx,
              runId,
              clientFactory: opts.clientFactory,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (table) table.setErrored(cardId, null, msg, runSetCtx.attemptNumber);
            throw err;
          }
        },
      });
      setResult = await handle.completion;
    } finally {
      detach();
    }
    if (cancelToken.cancelled) process.exit(130);

    if (table) {
      table.finalize();
    } else if (opts.silent) {
      const by = setResult.summary?.overall.byStatus;
      const pass = by?.pass ?? 0;
      const fail = by?.fail ?? 0;
      const investigate = by?.investigate ?? 0;
      const errored = by?.errored ?? 0;
      console.error(
        `batch: ${pass} pass · ${fail} fail · ${investigate} investigate · ${errored} errored`,
      );
      console.error(`results: ${resultsRoot}`);
    }

    const overall = setResult.summary?.overall.byStatus;
    const anyNonPass =
      (overall?.fail ?? 0) +
      (overall?.investigate ?? 0) +
      (overall?.errored ?? 0) +
      (overall?.cancelled ?? 0);
    return anyNonPass === 0 ? 0 : 1;
  } else {
    // Single card, single pass — preserve today's batch behavior exactly.
    // No RunSet artifact.
    const c = cards[0];
    if (table) table.setQueued(c.id);

    let pass = 0, fail = 0, investigate = 0, errored = 0;

    let currentRunId: string | null = null;

    const onLogger = (logger: EvidenceLogger) => {
      const observer: EventObserver = (ev) => {
        const t = ev.type as string;
        if (t === "run_start") {
          currentRunId = String((ev as any).runId);
          if (table) {
            table.setRunning(c.id, currentRunId);
          }
        } else if (t === "llm_response") {
          if (table) table.onTurn(c.id, Number((ev as any).turn ?? 0));
        } else if (t === "run_end") {
          const status = String((ev as any).status ?? "fail") as "pass" | "fail" | "investigate";
          const turns = Number(((ev as any).usage?.turns) ?? 0);
          if (table) table.setDone(c.id, status, turns);
        }

        if (opts.format === "jsonl" && !opts.silent) {
          const enriched = { runId: currentRunId, ...ev };
          opts.sink.write(JSON.stringify(enriched) + "\n");
        }
      };
      return logger.addEventObserver(observer);
    };

    try {
      const summary = await runOneImpl({
        scenarioPath: c.scenarioPath,
        target: opts.target,
        adapterType: opts.adapterType,
        config: opts.config,
        onLogger,
        clientFactory: opts.clientFactory,
      });
      const s = summary.result.status;
      switch (s) {
        case "pass": pass++; break;
        case "fail": fail++; break;
        case "investigate": investigate++; break;
        case "errored": errored++; break;
        default: {
          const _exhaustive: never = s;
          throw new Error(`unexpected VetStatus: ${JSON.stringify(_exhaustive)}`);
        }
      }
    } catch (err) {
      errored++;
      const msg = err instanceof Error ? err.message : String(err);
      if (table) table.setErrored(c.id, null, msg);
    }

    if (table) {
      table.finalize();
    } else if (opts.silent) {
      console.error(
        `batch: ${pass} pass · ${fail} fail · ${investigate} investigate · ${errored} errored`,
      );
      console.error(`results: ${resultsRoot}`);
    }

    return (fail + investigate + errored) === 0 ? 0 : 1;
  }
}
