import { readFileSync } from "fs";
import { join } from "path";
import { parseStoryCard } from "../format/story-card";
import { EvidenceLogger } from "../evidence/logger";
import { writeResultFiles } from "../evidence/writer";
import { runAgent } from "../agent/agent";
import { createClient, resolveProvider } from "../models/resolve";
import { CLIAdapter } from "../adapters/cli/adapter";
import { snapshotViewport } from "../adapters/adapter";
import { renderContextTree } from "../context/tree";
import { makeRunId } from "../util/id";
import { gauntletPath } from "../paths";
import { snapshotRunInputs } from "../runs/snapshot";
import type { AppConfig, Viewport } from "../config";
import type { RunConfigSnapshot, VetResult } from "../types";

function viewportString(v: Viewport | undefined): string | undefined {
  return v ? `${v.width}x${v.height}` : undefined;
}

export interface RunOneOptions {
  scenarioPath: string;
  target: string;
  outDir?: string;
  adapterType: "web" | "cli" | "tui";
  config: AppConfig;
  /** Invoked once with the freshly constructed EvidenceLogger, before
   * `runAgent` starts. Returns a detach function that runOne calls in its
   * `finally`. The single-card command uses this to attach the streaming
   * renderer; batch.ts uses it to subscribe its per-card observer. */
  onLogger?: (logger: EvidenceLogger) => () => void;
}

export interface RunOneSummary {
  runId: string;
  outDir: string;
  result: VetResult;
}

export async function runOne(opts: RunOneOptions): Promise<RunOneSummary> {
  const { scenarioPath, target, adapterType, config } = opts;

  const content = readFileSync(scenarioPath, "utf-8");
  const card = parseStoryCard(content);
  const runId = makeRunId(card.id);
  const outDir = opts.outDir ?? gauntletPath(config.projectRoot, "results", runId);
  snapshotRunInputs({
    runDir: outDir,
    storyPath: scenarioPath,
    contextRoot: gauntletPath(config.projectRoot, "context"),
  });
  const logger = new EvidenceLogger(outDir);
  const detach = opts.onLogger?.(logger) ?? (() => {});

  const client = createClient(config.models.agent);
  const contextRoot = join(outDir, "inputs", "context");
  const contextTree = renderContextTree(contextRoot);

  let adapter;
  switch (adapterType) {
    case "cli":
      adapter = new CLIAdapter({ contextRoot });
      await adapter.start(target);
      break;
    case "tui": {
      const { TUIAdapter } = await import("../adapters/tui/adapter");
      adapter = new TUIAdapter({ contextRoot });
      await adapter.start(target);
      break;
    }
    case "web": {
      const { WebAdapter } = await import("../adapters/web/adapter");
      const chromeOpt = config.sources.defaultChrome === "default"
        ? undefined
        : config.defaultChrome;
      const chromeProfileName = `gauntlet-run-${runId}`;
      adapter = new WebAdapter({
        chrome: chromeOpt,
        contextRoot,
        logger,
        chromeProfileName,
        viewport: config.defaultViewport,
      });
      await adapter.start(target);
      break;
    }
  }

  const chromeOptForSnapshot = config.sources.defaultChrome === "default"
    ? undefined
    : config.defaultChrome;
  const runConfig: RunConfigSnapshot = {
    target,
    model: config.models.agent,
    adapter: adapterType,
    chrome: chromeOptForSnapshot ? `${chromeOptForSnapshot.host}:${chromeOptForSnapshot.port}` : undefined,
    turns: config.defaultTurns,
    viewport: snapshotViewport(adapter),
  };

  try {
    const result = await runAgent(card, adapter, client, logger, target, {
      contextTree,
      runId,
      maxTurns: config.defaultTurns,
      provider: resolveProvider(config.models.agent),
      model: config.models.agent,
      outDir,
      viewport: adapterType === "web" ? viewportString(snapshotViewport(adapter)) : undefined,
    });
    result.config = runConfig;
    writeResultFiles(outDir, result);
    return { runId, outDir, result };
  } catch (err) {
    logger.logEvent("run_error", {
      turn: -1,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  } finally {
    detach();
    await adapter.close();
  }
}
