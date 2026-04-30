import { Hono } from "hono";
import { join } from "path";
import { readFileSync } from "fs";
import { findCard } from "../../cards/store";
import { createClient, resolveProvider } from "../../models/resolve";
import { EvidenceLogger } from "../../evidence/logger";
import { writeResultFiles } from "../../evidence/writer";
import { runAgent } from "../../agent/agent";
import { renderContextTree } from "../../context/tree";
import { makeRunId } from "../../util/id";
import { gauntletPath } from "../../paths";
import { snapshotRunInputs } from "../../runs/snapshot";
import { mergeRunConfig, validateRunBody, type AppConfig, type ChromeEndpoint, type Viewport } from "../../config";
import { snapshotViewport, type Adapter } from "../../adapters/adapter";
import { runRunSet } from "../../runs/run-set";
import type { RunBroadcaster } from "../ws";
import type { ActiveRunRegistry } from "../active-runs";
import type { RunSetBroadcaster } from "../run-set-broadcaster";
import type { CancelTokenRegistry } from "../run-cancel";
import type { ScreencastStreamer as ScreencastStreamerType } from "../../streaming/screencast";
import type { ErrorLog } from "./errors";
import type { StoryCard } from "../../format/story-card";
import type { LLMClient } from "../../models/provider";
import type { RunConfigSnapshot } from "../../types";
import type { RunSetCtx } from "../../runs/run-set-types";

function viewportString(v: Viewport | undefined): string | undefined {
  return v ? `${v.width}x${v.height}` : undefined;
}

function createAdapter(
  type: string,
  chrome: ChromeEndpoint | undefined,
  contextRoot: string,
  logger: EvidenceLogger,
  chromeProfileName: string | undefined,
  viewport: Viewport | undefined,
): Adapter {
  switch (type) {
    case "cli": {
      const { CLIAdapter } = require("../../adapters/cli/adapter");
      return new CLIAdapter({ contextRoot });
    }
    case "tui": {
      const { TUIAdapter } = require("../../adapters/tui/adapter");
      return new TUIAdapter({ contextRoot });
    }
    case "web": {
      const { WebAdapter } = require("../../adapters/web/adapter");
      return new WebAdapter({ chrome, contextRoot, logger, chromeProfileName, viewport });
    }
    default:
      throw new Error(`Unknown adapter type: ${type}`);
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
    const entry = findCard(config.projectRoot, c.req.param("id"), errorLog);
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

    const client = clientFactory
      ? clientFactory(effective.model)
      : createClient(effective.model);

    const passes = body.passes ?? 1;

    if (passes === 1) {
      // ── Solo path (unchanged behavior, new response shape) ──
      // runId is the primary key for the run end to end: results dir,
      // active-runs registry, WS broadcaster channel, and the runId field
      // written into result.json. The cardId is preserved as payload
      // metadata where it matters (the registry, the result manifest).
      const runId = makeRunId(entry.card.id);
      const outDir = gauntletPath(config.projectRoot, "results", runId);
      // Snapshot story + context into <outDir>/inputs/ synchronously,
      // before the logger, the adapter, the tree renderer, or the
      // detached executeRun touch anything. Downstream consumers then
      // see the snapshotted paths. The story path is composed from the
      // stories dir + the filename findCard already resolved for us.
      snapshotRunInputs({
        runDir: outDir,
        storyPath: join(gauntletPath(config.projectRoot, "stories"), entry.filename),
        contextRoot: gauntletPath(config.projectRoot, "context"),
      });
      const contextRoot = join(outDir, "inputs", "context");
      // Create the logger *before* the adapter so WebAdapter can open its
      // background observer session against it in start().
      const logger = new EvidenceLogger(outDir);
      // Per-run Chrome profile name for browser state isolation (spec
      // §5.1). The cardId is already encoded in runId, so no additional
      // suffix is needed.
      const chromeProfileName = `gauntlet-run-${runId}`;
      const adapter = createAdapter(effective.adapter, effective.chrome, contextRoot, logger, chromeProfileName, effective.viewport);
      const runConfig: RunConfigSnapshot = {
        target: effective.target,
        model: effective.model,
        adapter: effective.adapter,
        chrome: effective.chrome ? `${effective.chrome.host}:${effective.chrome.port}` : undefined,
        turns: effective.turns,
        viewport: snapshotViewport(adapter),
      };
      // Render the tree **once per run** — the immutability invariant
      // (spec §4.2) forbids re-rendering during the run.
      const contextTree = renderContextTree(contextRoot);

      const startedAt = Date.now();
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
      }

      // Detach: run the agent in the background. The HTTP request returns now.
      executeRun({
        runId,
        card: entry.card,
        adapter,
        adapterType: effective.adapter,
        client,
        target: effective.target,
        outDir,
        logger,
        broadcaster,
        registry,
        errorLog,
        startedAt,
        contextTree,
        maxTurns: effective.turns,
        runConfig,
        saveScreencast: effective.saveScreencast,
        provider: resolveProvider(effective.model),
        model: effective.model,
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        errorLog?.add("run", `${runId}: ${message}`);
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

    const handle = await runRunSet({
      resultsRoot: gauntletPath(config.projectRoot),
      cards: [entry.card.id],
      passes,
      kind: "single",
      cancelToken,
      executor: async ({ runSetCtx, runId }) => {
        if (registry) registry.setStatus(runId, "running");
        if (setBroadcaster) {
          setBroadcaster.send(runSetCtx.runSetId, {
            kind: "pass_start", runId, attemptNumber: runSetCtx.attemptNumber, passes,
          });
        }

        const outDir = gauntletPath(config.projectRoot, "results", runId);
        snapshotRunInputs({
          runDir: outDir,
          storyPath: join(gauntletPath(config.projectRoot, "stories"), entry.filename),
          contextRoot: gauntletPath(config.projectRoot, "context"),
        });
        const contextRoot = join(outDir, "inputs", "context");
        const logger = new EvidenceLogger(outDir);
        const chromeProfileName = `gauntlet-run-${runId}`;
        const adapter = createAdapter(effective.adapter, effective.chrome, contextRoot, logger, chromeProfileName, effective.viewport);
        const runConfig: RunConfigSnapshot = {
          target: effective.target,
          model: effective.model,
          adapter: effective.adapter,
          chrome: effective.chrome ? `${effective.chrome.host}:${effective.chrome.port}` : undefined,
          turns: effective.turns,
          viewport: snapshotViewport(adapter),
        };
        const contextTree = renderContextTree(contextRoot);
        const startedAt = Date.now();

        await executeRun({
          runId,
          card: entry.card,
          adapter,
          adapterType: effective.adapter,
          client,
          target: effective.target,
          outDir,
          logger,
          broadcaster,
          registry,
          errorLog,
          startedAt,
          contextTree,
          maxTurns: effective.turns,
          runConfig,
          saveScreencast: effective.saveScreencast,
          provider: resolveProvider(effective.model),
          model: effective.model,
          runSetCtx,
        });

        // executeRun writes result.json and unregisters from registry.
        // Read the result back for orchestrator bookkeeping.
        let result;
        try {
          result = JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));
        } catch {
          // If result.json is missing (errored run), construct a minimal error result.
          result = { status: "fail" };
        }

        if (setBroadcaster) {
          setBroadcaster.send(runSetCtx.runSetId, {
            kind: "pass_end", runId, attemptNumber: runSetCtx.attemptNumber,
            finalStatus: result.status,
          });
        }

        return { runId, outDir, result };
      },
    });

    // Pre-register all attempts as queued (before the loop starts).
    if (registry) {
      for (const r of handle.runs) {
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
          runSetId: handle.runSetId,
        });
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

export interface ExecuteRunOpts {
  /**
   * Primary identity for the run. Threads through the broadcaster
   * channel, the registry key, and the runId field stamped into the
   * written result. Optional only so legacy test fixtures can omit it;
   * production routes always provide one via `makeRunId(card.id)`.
   */
  runId?: string;
  card: StoryCard;
  adapter: Adapter;
  adapterType: string;
  client: LLMClient;
  target: string;
  outDir: string;
  logger: EvidenceLogger;
  broadcaster?: RunBroadcaster;
  registry?: ActiveRunRegistry;
  errorLog?: ErrorLog;
  /** Token used to guard against clobbering a freshly-registered entry
   * with the same key. */
  startedAt?: number;
  /**
   * Rendered context tree from `renderContextTree`. Built once per run
   * by the route handler and threaded to `runAgent` so the system
   * prompt's Context section can be assembled at turn 0. See spec §4.2.
   */
  contextTree?: string;
  /** Per-run cap on agent turns. Omit for the agent default (50). */
  maxTurns?: number;
  /** Config snapshot stamped into result.json. */
  runConfig?: RunConfigSnapshot;
  /**
   * When true, the screencast streamer also writes frames to
   * `<outDir>/frames/`. When false, frames still fan out to the
   * broadcaster/registry for live viewing, but nothing touches disk.
   * Omit to inherit the legacy always-save behavior — production callers
   * thread the merged flag through from the effective run config.
   */
  saveScreencast?: boolean;
  /** LLM provider name (e.g. "anthropic", "openai"). Threaded to run_start. */
  provider?: string;
  /** LLM model name. Threaded to run_start. */
  model?: string;
  /** Run set context for multi-pass orchestration. */
  runSetCtx?: RunSetCtx;
}

export async function executeRun(opts: ExecuteRunOpts): Promise<void> {
  const { runId: optsRunId, card, adapter, adapterType, client, target, outDir, logger, broadcaster, registry, errorLog, startedAt, contextTree, maxTurns, runConfig, saveScreencast, provider, model, runSetCtx } = opts;
  // Routing key for the broadcaster and registry. Defaults to cardId so
  // ad-hoc test fixtures continue to work without supplying a runId.
  const runId = optsRunId ?? card.id;

  let unsubscribeObserver: (() => void) | undefined;
  if (broadcaster || registry) {
    unsubscribeObserver = logger.addObserver((action, params) => {
      const message = `[${action}] ${JSON.stringify(params)}`;
      broadcaster?.send(runId, {
        type: "progress",
        message,
        status: "running",
        card: card.id,
      });
      registry?.recordProgress(runId, message);
    });
  }

  // Independent observer channel carrying the full structured jsonl
  // entry for the transcript WS consumers (spec §6.3). Legacy progress
  // path above is unchanged; these fire side-by-side.
  let unsubscribeEventObserver: (() => void) | undefined;
  if (broadcaster) {
    unsubscribeEventObserver = logger.addEventObserver((event) => {
      broadcaster.send(runId, { type: "event", event });
    });
  }

  let streamer: ScreencastStreamerType | undefined;
  let terminal: Record<string, unknown> | null = null;

  try {
    await adapter.start(target);

    if (adapterType === "web" && (broadcaster || registry)) {
      const { ScreencastStreamer } = await import("../../streaming/screencast");
      // The live WS stream (broadcaster.send) is always on — the
      // streamer writes to disk only when saveScreencast is true.
      // Legacy callers that omit the flag retain the previous
      // always-save behavior; the production route threads
      // effective.saveScreencast (default false).
      const framesDir = saveScreencast === false ? undefined : join(outDir, "frames");
      // PRI-1436: share the WebAdapter's chrome-ws-lib session so the
      // screencast talks to the same Chrome the adapter started (correct
      // activePort, correct connection pool). Without this, the streamer
      // would create its own session whose activePort was never set by
      // startChrome.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const webAdapter = adapter as any;
      // The branch above already gates on adapterType === "web", so the
      // adapter is always a WebAdapter here and getChromeSession is defined.
      const chromeSession = webAdapter.getChromeSession();
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

    const result = await runAgent(card, adapter, client, logger, target, {
      contextTree,
      runId,
      maxTurns,
      provider,
      model,
      outDir,
      viewport: adapterType === "web" ? viewportString(snapshotViewport(adapter)) : undefined,
    });
    if (runConfig) result.config = runConfig;
    if (runSetCtx) result.runSet = runSetCtx;
    writeResultFiles(outDir, result);

    terminal = { type: "complete", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorLog?.add("run", `${runId}: ${message}`);
    terminal = { type: "error", message };
  } finally {
    unsubscribeObserver?.();
    unsubscribeEventObserver?.();
    if (streamer) {
      try {
        await streamer.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      await adapter.close();
    } catch {
      /* ignore */
    }
    registry?.unregister(runId, startedAt);
    // Emit the terminal event AFTER unregister so a late-connecting
    // WebSocket sees an empty registry (and receives `gone`) instead of a
    // stale snapshot that would never get a follow-up event.
    if (terminal) broadcaster?.send(runId, terminal);
  }
}
