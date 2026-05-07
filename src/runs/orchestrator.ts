import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { CLIAdapter } from "../adapters/cli/adapter";
import { snapshotViewport, type Adapter } from "../adapters/adapter";
import type { ChromeEndpoint, Viewport } from "../config";
import { renderContextTree } from "../context/tree";
import { EvidenceLogger } from "../evidence/logger";
import { writeResultFiles } from "../evidence/writer";
import { runAgent } from "../agent/agent";
import { resolveProvider } from "../models/resolve";
import type { LLMClient } from "../models/provider";
import { gauntletPath } from "../paths";
import { snapshotRunInputs } from "./snapshot";
import { makeRunId } from "../util/id";
import type { StoryCard } from "../format/story-card";
import type { RunConfigSnapshot, VetResult } from "../types";
import type { RunSetCtx } from "./run-set-types";

export type RunAdapterType = "web" | "cli" | "tui";

/**
 * Resolve the Project prompt block. Explicit path wins; otherwise look
 * for .gauntlet/project.md in the project root; otherwise undefined.
 * Missing explicit path is a hard error (the caller asked for it).
 */
export function resolveProjectPrompt(
  projectRoot: string,
  explicitPath: string | undefined,
): string | undefined {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`--project-prompt file not found: ${explicitPath}`);
    }
    return readFileSync(explicitPath, "utf-8").replace(/\s+$/, "");
  }
  const defaultPath = join(projectRoot, ".gauntlet", "project.md");
  if (existsSync(defaultPath)) {
    return readFileSync(defaultPath, "utf-8").replace(/\s+$/, "");
  }
  return undefined;
}

export interface RunCoreConfig {
  projectRoot: string;
  model: string;
  adapter: RunAdapterType;
  target: string;
  turns: number;
  /** Already-resolved Chrome endpoint, or undefined to let WebAdapter
   * auto-launch. Surfaces collapse "default" → undefined themselves. */
  chrome?: ChromeEndpoint;
  viewport?: Viewport;
}

export interface RunCorePrepared {
  runId: string;
  outDir: string;
  card: StoryCard;
}

export interface RunCoreStarted extends RunCorePrepared {
  contextRoot: string;
  /** The started adapter. Hooks may read state (e.g., a WebAdapter's
   * chrome session for screencast wiring) but must not start, close, or
   * otherwise mutate the lifecycle — that is the core's job. */
  adapter: Adapter;
}

export interface RunCoreHooks {
  /** Attach observers to the freshly-built logger. Optional detach fn is
   * called after adapter close so close-time events still fan out. */
  onLogger?: (logger: EvidenceLogger, ctx: RunCorePrepared) => void | (() => void);
  beforeAgent?: (ctx: RunCoreStarted) => Promise<void> | void;
  onError?: (err: unknown, ctx: RunCoreStarted | RunCorePrepared) => Promise<void> | void;
  beforeClose?: (ctx: RunCoreStarted) => Promise<void> | void;
  afterClose?: (ctx: RunCoreStarted | RunCorePrepared) => Promise<void> | void;
}

export interface AdapterFactoryCtx {
  contextRoot: string;
  runId: string;
  logger: EvidenceLogger;
}

export interface ExecuteRunCoreOptions {
  card: StoryCard;
  storyPath: string;
  runId?: string;
  outDir?: string;
  runConfig: RunCoreConfig;
  /** Already-built client — surfaces resolve provider/allow-list before
   * calling the core so config errors stay on the request thread. */
  client: LLMClient;
  runSetCtx?: RunSetCtx;
  hooks?: RunCoreHooks;
  /** Test seam: substitute the adapter construction. Production callers
   * leave this undefined and the core builds the adapter from
   * `runConfig.adapter`. Tests inject stub adapters here instead of
   * `mock.module`-ing adapter modules globally. Mirrors the
   * `clientFactory?` pattern from PRI-1505. */
  adapterFactory?: (ctx: AdapterFactoryCtx) => Adapter | Promise<Adapter>;
  /** Optional explicit path to a Project prompt augmentation file. When
   * unset, `resolveProjectPrompt` falls through to `.gauntlet/project.md`
   * under `runConfig.projectRoot` (or no Project block if that's absent). */
  projectPromptPath?: string;
}

export interface ExecuteRunCoreResult {
  runId: string;
  outDir: string;
  result: VetResult;
}

function viewportString(v: Viewport | undefined): string | undefined {
  return v ? `${v.width}x${v.height}` : undefined;
}

async function buildDefaultAdapter(
  type: RunAdapterType,
  contextRoot: string,
  logger: EvidenceLogger,
  runId: string,
  chrome: ChromeEndpoint | undefined,
  viewport: Viewport | undefined,
): Promise<Adapter> {
  switch (type) {
    case "cli":
      return new CLIAdapter({ contextRoot });
    case "tui": {
      const { TUIAdapter } = await import("../adapters/tui/adapter");
      return new TUIAdapter({ contextRoot });
    }
    case "web": {
      const { WebAdapter } = await import("../adapters/web/adapter");
      return new WebAdapter({
        chrome,
        contextRoot,
        logger,
        chromeProfileName: `gauntlet-run-${runId}`,
        viewport,
      });
    }
  }
}

export async function executeRunCore(
  opts: ExecuteRunCoreOptions,
): Promise<ExecuteRunCoreResult> {
  const { card, storyPath, runConfig, client, runSetCtx, hooks } = opts;

  const runId = opts.runId ?? makeRunId(card.id);
  const outDir = opts.outDir ?? gauntletPath(runConfig.projectRoot, "results", runId);

  snapshotRunInputs({
    runDir: outDir,
    storyPath,
    contextRoot: gauntletPath(runConfig.projectRoot, "context"),
  });

  const logger = new EvidenceLogger(outDir);
  const prepared: RunCorePrepared = { runId, outDir, card };
  const detachLogger = hooks?.onLogger?.(logger, prepared) ?? (() => {});

  const contextRoot = join(outDir, "inputs", "context");
  const contextTree = renderContextTree(contextRoot);
  const projectPrompt = resolveProjectPrompt(runConfig.projectRoot, opts.projectPromptPath);

  const adapter = await (opts.adapterFactory
    ? opts.adapterFactory({ contextRoot, runId, logger })
    : buildDefaultAdapter(
        runConfig.adapter,
        contextRoot,
        logger,
        runId,
        runConfig.chrome,
        runConfig.viewport,
      ));

  try {
    await adapter.start(runConfig.target);
    const started: RunCoreStarted = { ...prepared, contextRoot, adapter };
    await hooks?.beforeAgent?.(started);

    const stampedRunConfig: RunConfigSnapshot = {
      target: runConfig.target,
      model: runConfig.model,
      adapter: runConfig.adapter,
      chrome: runConfig.chrome ? `${runConfig.chrome.host}:${runConfig.chrome.port}` : undefined,
      turns: runConfig.turns,
      viewport: snapshotViewport(adapter),
    };

    const result = await runAgent(card, adapter, client, logger, runConfig.target, {
      contextTree,
      projectPrompt,
      runId,
      maxTurns: runConfig.turns,
      provider: resolveProvider(runConfig.model),
      model: runConfig.model,
      outDir,
      viewport: runConfig.adapter === "web"
        ? viewportString(snapshotViewport(adapter))
        : undefined,
    });
    result.config = stampedRunConfig;
    if (runSetCtx) result.runSet = runSetCtx;
    writeResultFiles(outDir, result);

    await hooks?.beforeClose?.(started);
    try { await adapter.close(); } catch { /* swallow */ }
    detachLogger();
    await hooks?.afterClose?.(started);

    return { runId, outDir, result };
  } catch (err) {
    logger.logRunError({
      turn: -1,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const ctx: RunCoreStarted = { ...prepared, contextRoot, adapter };
    try { await hooks?.onError?.(err, ctx); } catch { /* swallow */ }
    try { await hooks?.beforeClose?.(ctx); } catch { /* swallow */ }
    try { await adapter.close(); } catch { /* swallow */ }
    detachLogger();
    try { await hooks?.afterClose?.(ctx); } catch { /* swallow */ }
    throw err;
  }
}
