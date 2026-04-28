import { basename, extname } from "path";
import type { AppConfig } from "../config";
import type { EvidenceLogger, EventObserver } from "../evidence/logger";
import { gauntletPath } from "../paths";
import { runOne, type RunOneOptions, type RunOneSummary } from "./run-one";
import { BatchTableRenderer } from "./stream/batch-table";
import type { WriteSink } from "./stream/jsonl";

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
}

type RunOneFn = (opts: RunOneOptions) => Promise<RunOneSummary>;

function cardIdForPath(p: string): string {
  // v1: filename stem is the row identifier. Stable for queued rows
  // (no parse needed) and for parse-failure rows.
  return basename(p, extname(p));
}

export async function runBatch(
  opts: BatchOptions,
  runOneImpl: RunOneFn = runOne,
): Promise<number> {
  const cards = opts.scenarioPaths.map((p) => ({ path: p, cardId: cardIdForPath(p) }));
  const resultsRoot = gauntletPath(opts.config.projectRoot, "results");
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

  if (table) for (const c of cards) table.setQueued(c.cardId);

  let pass = 0, fail = 0, investigate = 0, errored = 0;

  for (const c of cards) {
    let currentRunId: string | null = null;

    const onLogger = (logger: EvidenceLogger) => {
      const observer: EventObserver = (ev) => {
        const t = ev.type as string;
        if (t === "run_start") {
          currentRunId = String((ev as any).runId);
          if (table) {
            table.setRunning(c.cardId, currentRunId, Number((ev as any).maxTurns ?? 0));
          }
        } else if (t === "llm_response") {
          if (table) table.onTurn(c.cardId, Number((ev as any).turn ?? 0));
        } else if (t === "run_end") {
          const status = String((ev as any).status ?? "fail") as "pass" | "fail" | "investigate";
          const turns = Number(((ev as any).usage?.turns) ?? 0);
          if (table) table.setDone(c.cardId, status, turns);
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
        scenarioPath: c.path,
        target: opts.target,
        adapterType: opts.adapterType,
        config: opts.config,
        onLogger,
      });
      const s = summary.result.status;
      switch (s) {
        case "pass": pass++; break;
        case "fail": fail++; break;
        case "investigate": investigate++; break;
        default: {
          const _exhaustive: never = s;
          throw new Error(`unexpected VetStatus: ${JSON.stringify(_exhaustive)}`);
        }
      }
    } catch (err) {
      errored++;
      const msg = err instanceof Error ? err.message : String(err);
      if (table) table.setErrored(c.cardId, null, msg);
    }
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
