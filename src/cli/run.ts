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
import type { AppConfig } from "../config";
import type { RunConfigSnapshot } from "../types";
import { resolveStreamOptions } from "./stream/format";
import { attachRenderer } from "./stream/attach";
import type { Viewport } from "../config";

function viewportString(v: Viewport | undefined): string | undefined {
  return v ? `${v.width}x${v.height}` : undefined;
}

export interface RunCommandOptions {
  scenarioPath: string;
  target: string;
  outDir?: string;
  adapterType: "web" | "cli" | "tui";
  config: AppConfig;
  silent: boolean;
  format: "pretty" | "jsonl" | undefined;
  noColor: boolean;
}

export async function run(opts: RunCommandOptions): Promise<void> {
  const { scenarioPath, target, adapterType, config } = opts;

  // LLM-capable gate is enforced by the dispatch site (src/index.ts via
  // requireLlmCapableOrExit). This function assumes a valid AppConfig.

  const content = readFileSync(scenarioPath, "utf-8");
  const card = parseStoryCard(content);
  // Generate runId first so we can derive the default outDir. Mirrors
  // the serve path (src/api/routes/run.ts): `gauntletPath(projectRoot,
  // "results", runId)` is the canonical run output location; `--out`
  // stays available as an explicit override for ad-hoc debugging.
  const runId = makeRunId(card.id);
  const outDir = opts.outDir ?? gauntletPath(config.projectRoot, "results", runId);
  // Snapshot story + context into <outDir>/inputs/ before anything
  // reads the context — and before createClient, which can throw on
  // unsupported models. Every downstream consumer (read-tool, passkey
  // tool, context-tree renderer) uses the snapshotted root, so the
  // agent sees a frozen view even if the source files change during
  // the run.
  snapshotRunInputs({
    runDir: outDir,
    storyPath: scenarioPath,
    contextRoot: gauntletPath(config.projectRoot, "context"),
  });
  const logger = new EvidenceLogger(outDir);
  const streamOpts = resolveStreamOptions({
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env as Record<string, string | undefined>,
    silent: opts.silent,
    format: opts.format,
    noColor: opts.noColor,
    columns: process.stdout.columns ?? 100,
  });
  const sink = { write: (s: string) => process.stdout.write(s) };
  const detachStream = attachRenderer(logger, streamOpts, sink);
  const client = createClient(config.models.agent);
  const contextRoot = join(outDir, "inputs", "context");
  // Render the tree once per run — the immutability invariant forbids
  // re-rendering during the run.
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
      // Only pass an endpoint if the user explicitly set one (env or flag).
      // When the source is "default", leave it undefined so WebAdapter
      // auto-launches a local headless Chrome — preserving the pre-refactor
      // behavior of plain `gauntlet run card.md --target ...`.
      const chromeOpt = config.sources.defaultChrome === "default"
        ? undefined
        : config.defaultChrome;
      // Per-run Chrome profile name for browser state isolation (spec
      // §5.1). The cardId is already encoded in runId.
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
    if (streamOpts.silent) {
      // Silent: one-line stderr pointer, no stdout output.
      console.error(`runId: ${runId}`);
    }
    // Streaming mode: run_end panel already printed the runId via the renderer.
  } catch (err) {
    logger.logEvent("run_error", {
      turn: -1,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  } finally {
    detachStream();
    await adapter.close();
  }
}
