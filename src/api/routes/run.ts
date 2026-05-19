import { Hono } from "hono";
import { join } from "path";
import { findCard } from "../../cards/store";
import {
  SUPPORTED_MODEL_PREFIXES_MESSAGE,
  UnknownModelProviderError,
  createClientForProvider,
  resolveProvider,
} from "../../models/resolve";
import { makeRunId } from "../../util/id";
import { gauntletPath } from "../../paths";
import { mergeRunConfig, validateRunBody, type AppConfig } from "../../config";
import { runRunSet } from "../../runs/run-set";
import {
  executeRunCore,
  type ExecuteRunCoreOptions,
  type ExecuteRunCoreResult,
  type RunCoreHooks,
} from "../../runs/orchestrator";
import type { RunBroadcaster } from "../ws";
import type { ActiveRunRegistry } from "../active-runs";
import type { RunSetBroadcaster } from "../run-set-broadcaster";
import type { CancelTokenRegistry } from "../run-cancel";
import type { ScreencastStreamer as ScreencastStreamerType } from "../../streaming/screencast";
import type { ErrorLog } from "../../util/error-log";
import type { StoryCard } from "../../format/story-card";
import type { LLMClient } from "../../models/provider";
import type { RunSetCtx } from "../../runs/run-set-types";
import type { RunId } from "../../util/brands";

export interface ExecuteHttpRunOpts {
  runId: RunId;
  card: StoryCard;
  storyPath: string;
  client: LLMClient;
  effective: ReturnType<typeof mergeRunConfig>;
  projectRoot: string;
  broadcaster?: RunBroadcaster;
  registry?: ActiveRunRegistry;
  errorLog?: ErrorLog;
  /** Token used to guard against clobbering a freshly-registered entry
   * with the same key. Omit for multi-pass attempts so the unregister
   * always wins; pre-register-then-detach (solo) supplies it. */
  startedAt?: number;
  runSetCtx?: RunSetCtx;
  /** Test seam: forwarded to executeRunCore. Production routes leave
   * undefined; tests stub the adapter without touching modules. */
  adapterFactory?: ExecuteRunCoreOptions["adapterFactory"];
  /**
   * Optional cancellation signal — forwarded to executeRunCore for the
   * agent loop to observe. PRI-1507. The route's per-run AbortController
   * lives in the active-run registry; this is just the public signal end.
   */
  abortSignal?: AbortSignal;
}

/**
 * HTTP wrapper around executeRunCore. Owns: progress observer, event
 * observer, screencast streamer, error log writes, registry unregister,
 * terminal broadcast (in unregister-then-broadcast order so a
 * late-connecting WS sees an empty registry).
 */
export async function executeHttpRun(
  opts: ExecuteHttpRunOpts,
): Promise<ExecuteRunCoreResult> {
  const { runId, card, storyPath, client, effective, projectRoot,
          broadcaster, registry, errorLog, startedAt, runSetCtx } = opts;

  let streamer: ScreencastStreamerType | undefined;
  // `terminal` is null during the run and at afterClose time on the
  // success path. onError sets it before afterClose runs (error path); the
  // success branch sets it AFTER executeRunCore returns and broadcasts
  // directly. afterClose only sends if `terminal` is non-null, so success
  // is broadcast exactly once from the line below executeRunCore.
  let terminal: Record<string, unknown> | null = null;

  const hooks: RunCoreHooks = {
    onLogger: (logger) => {
      const detachers: Array<() => void> = [];
      if (broadcaster || registry) {
        detachers.push(logger.addProgressObserver((action, params) => {
          const message = `[${action}] ${JSON.stringify(params)}`;
          broadcaster?.send(runId, {
            type: "progress",
            message,
            status: "running",
            card: card.id,
          });
          registry?.recordProgress(runId, message);
        }));
      }
      if (broadcaster) {
        detachers.push(logger.addEventObserver((event) => {
          broadcaster.send(runId, { type: "event", event });
        }));
      }
      return () => { for (const d of detachers) d(); };
    },
    beforeAgent: async (ctx) => {
      if (effective.adapter === "web" && (broadcaster || registry)) {
        const { ScreencastStreamer } = await import("../../streaming/screencast");
        // PRI-1436: share the WebAdapter's chrome-ws-lib session so the
        // screencast talks to the same Chrome the adapter started
        // (correct activePort, correct connection pool).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const webAdapter = ctx.adapter as any;
        const chromeSession = webAdapter.getChromeSession();
        const framesDir = effective.saveScreencast === false
          ? undefined
          : join(gauntletPath(projectRoot, effective.stateDirName, "results", runId), "frames");
        streamer = new ScreencastStreamer(0, (frame) => {
          broadcaster?.send(runId, {
            type: "frame",
            data: frame.data,
            width: frame.metadata.width,
            height: frame.metadata.height,
          });
          registry?.recordFrame(runId, {
            data: frame.data,
            width: frame.metadata.width,
            height: frame.metadata.height,
          });
        }, chromeSession, framesDir);
        await streamer.start();
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      errorLog?.add("run", `${runId}: ${message}`);
      terminal = { type: "error", message };
    },
    beforeClose: async () => {
      if (streamer) {
        try { await streamer.stop(); } catch { /* ignore */ }
      }
    },
    afterClose: () => {
      registry?.unregister(runId, startedAt);
      if (terminal) broadcaster?.send(runId, terminal);
    },
  };

  try {
    const result = await executeRunCore({
      card,
      storyPath,
      runId,
      client,
      runSetCtx,
      adapterFactory: opts.adapterFactory,
      abortSignal: opts.abortSignal,
      runConfig: effective,
      hooks,
    });
    terminal = { type: "complete", result: result.result };
    // afterClose has already run by this point in the success path,
    // so emit the success terminal directly.
    broadcaster?.send(runId, terminal);
    return result;
  } catch (err) {
    // onError already populated `terminal` and ErrorLog; afterClose
    // already broadcast it. Just rethrow so the multi-pass executor
    // observes the failure.
    throw err;
  }
}

export function runRoutes(
  config: AppConfig,
  broadcaster?: RunBroadcaster,
  errorLog?: ErrorLog,
  registry?: ActiveRunRegistry,
  setBroadcaster?: RunSetBroadcaster,
  cancelTokens?: CancelTokenRegistry,
  clientFactory?: (model: string) => LLMClient,
) {
  const router = new Hono();

  router.post("/:id", async (c) => {
    const entry = findCard(config.projectRoot, config.stateDirName, c.req.param("id"), errorLog);
    if (!entry) return c.json({ error: "not found" }, 404);

    const rawBody = await c.req.json().catch(() => ({}));
    let body;
    try {
      body = validateRunBody(rawBody);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    let effective;
    try {
      effective = mergeRunConfig(config, body);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    if (config.models.available.length > 0 && !config.models.available.includes(effective.model)) {
      return c.json({ error: `model "${effective.model}" is not in GAUNTLET_MODELS allow-list` }, 400);
    }

    // Concurrency cap (PRI-1478). Refuse new runs when at the operator-
    // configured ceiling so a flood of POSTs can't pin the daemon.
    if (registry && registry.list().length >= config.maxConcurrentRuns) {
      c.header("Retry-After", "5");
      return c.json({
        error: "too_many_runs",
        message: `at concurrency cap of ${config.maxConcurrentRuns} in-flight runs`,
        cap: config.maxConcurrentRuns,
      }, 429);
    }

    let provider;
    try {
      provider = resolveProvider(effective.model);
    } catch (err) {
      if (err instanceof UnknownModelProviderError) {
        return c.json({
          error: "unknown_model",
          message: `Model not supported. ${SUPPORTED_MODEL_PREFIXES_MESSAGE}`,
        }, 400);
      }
      throw err;
    }

    const client = clientFactory
      ? clientFactory(effective.model)
      : createClientForProvider(effective.model, provider);

    const passes = body.passes ?? 1;
    const storyPath = join(gauntletPath(config.projectRoot, config.stateDirName, "stories"), entry.filename);

    if (passes === 1) {
      // ── Solo path ──
      const runId = makeRunId(entry.card.id);
      const startedAt = Date.now();
      const ac = new AbortController();
      if (registry) {
        registry.register({
          id: runId,
          cardId: entry.card.id,
          title: entry.card.title,
          target: effective.target,
          model: effective.model,
          startedAt,
          status: "running",
        });
        registry.attachAbortController(runId, ac);
      }

      executeHttpRun({
        runId,
        card: entry.card,
        storyPath,
        client,
        effective,
        projectRoot: config.projectRoot,
        broadcaster,
        registry,
        errorLog,
        startedAt,
        abortSignal: ac.signal,
      }).catch(() => {
        // executeHttpRun's onError hook already wrote to errorLog and
        // broadcast the terminal error event before rethrowing. Swallow
        // here to satisfy the unhandled-rejection rule without
        // double-logging.
      });

      return c.json({
        runSetId: null,
        kind: "single",
        passes: 1,
        runs: [{ runId, attemptNumber: 1, status: "running" as const }],
      }, 202);
    }

    // ── Multi-pass path ──
    const cancelToken = { cancelled: false };

    // Per-attempt AbortControllers. PRI-1507. Populated synchronously
    // from `onAllRunsKnown` (which fires in runRunSet's prep phase,
    // BEFORE runLoop starts) so the executor can pick up its run's
    // controller on first invocation. Attaching inside the executor
    // would race with the registry not yet having entries — see plan
    // Step 5 / spec §4.
    const controllers = new Map<string, AbortController>();

    const handle = await runRunSet({
      resultsRoot: gauntletPath(config.projectRoot, config.stateDirName),
      cards: [entry.card.id],
      passes,
      kind: "single",
      cancelToken,
      onAllRunsKnown: (allRuns) => {
        for (const r of allRuns) {
          const ac = new AbortController();
          controllers.set(r.runId, ac);
          if (registry) {
            registry.register({
              id: r.runId,
              cardId: entry.card.id,
              title: entry.card.title,
              target: effective.target,
              model: effective.model,
              startedAt: Date.now(),
              status: "queued",
              attemptNumber: r.attemptNumber,
              passes,
              runSetId: undefined, // populated below once we know it; see post-await fixup
            });
            registry.attachAbortController(r.runId, ac);
          }
        }
      },
      executor: async ({ runSetCtx, runId }) => {
        if (registry) registry.setStatus(runId, "running");
        if (setBroadcaster) {
          setBroadcaster.send(runSetCtx.runSetId, {
            kind: "pass_start", runId, attemptNumber: runSetCtx.attemptNumber, passes,
          });
        }

        const { result, outDir } = await executeHttpRun({
          runId,
          card: entry.card,
          storyPath,
          client,
          effective,
          projectRoot: config.projectRoot,
          broadcaster,
          registry,
          errorLog,
          // No startedAt — see solo-path comment in legacy code.
          runSetCtx,
          abortSignal: controllers.get(runId)?.signal,
        });

        if (setBroadcaster) {
          setBroadcaster.send(runSetCtx.runSetId, {
            kind: "pass_end", runId, attemptNumber: runSetCtx.attemptNumber,
            finalStatus: result.status,
          });
        }

        return { runId, outDir, result };
      },
    });

    // Patch runSetId onto the registry entries pre-registered by
    // onAllRunsKnown (we didn't know the id at that point because
    // runRunSet generates it during prep — the handle is the source).
    if (registry) {
      for (const r of handle.runs) {
        const snap = registry.getSnapshot(r.runId);
        if (snap) snap.info.runSetId = handle.runSetId;
      }
    }

    if (cancelTokens) cancelTokens.register(handle.runSetId, cancelToken);

    handle.completion
      .then((setResult) => {
        if (setBroadcaster) {
          setBroadcaster.send(handle.runSetId, { kind: "set_done", summary: setResult.summary });
        }
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        errorLog?.add("run", `run-set ${handle.runSetId}: ${message}`);
      })
      .finally(() => {
        if (cancelTokens) cancelTokens.unregister(handle.runSetId);
        if (registry) {
          for (const r of handle.runs) registry.unregister(r.runId);
        }
      });

    return c.json({
      runSetId: handle.runSetId,
      kind: handle.kind,
      passes: handle.passes,
      runs: handle.runs.map((r) => ({
        runId: r.runId,
        attemptNumber: r.attemptNumber,
        status: "queued" as const,
      })),
    }, 202);
  });

  return router;
}
