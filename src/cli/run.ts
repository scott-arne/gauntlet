import { runOne } from "./run-one";
import { attachRenderer } from "./stream/attach";
import { resolveStreamOptions } from "./stream/format";
import type { AppConfig } from "../config";

export interface RunCommandOptions {
  scenarioPath: string;
  target: string;
  outDir?: string;
  adapterType: "web" | "cli" | "tui";
  config: AppConfig;
  silent: boolean;
  format: "pretty" | "jsonl" | undefined;
  noColor: boolean;
  passes: number;
}

// LLM-capable gate is enforced by the dispatch site (src/index.ts via
// requireLlmCapableOrExit). This function assumes a valid AppConfig.
export async function run(opts: RunCommandOptions): Promise<void> {
  const streamOpts = resolveStreamOptions({
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env as Record<string, string | undefined>,
    silent: opts.silent,
    format: opts.format,
    noColor: opts.noColor,
    columns: process.stdout.columns ?? 100,
  });
  const sink = { write: (s: string) => process.stdout.write(s) };

  const { runId } = await runOne({
    scenarioPath: opts.scenarioPath,
    target: opts.target,
    outDir: opts.outDir,
    adapterType: opts.adapterType,
    config: opts.config,
    onLogger: (logger) => attachRenderer(logger, streamOpts, sink),
  });

  if (streamOpts.silent) {
    console.error(`runId: ${runId}`);
  }
  // Streaming mode: run_end panel already printed the runId via the renderer.
}
