import type { Adapter } from "../adapters/adapter";
import type { ChromeEndpoint, Viewport } from "../config";
import type { EvidenceLogger } from "../evidence/logger";
import type { LLMClient } from "../models/provider";
import type { StoryCard } from "../format/story-card";
import type { VetResult } from "../types";
import type { RunSetCtx } from "./run-set-types";

export type RunAdapterType = "web" | "cli" | "tui";

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
}

export interface ExecuteRunCoreResult {
  runId: string;
  outDir: string;
  result: VetResult;
}

export async function executeRunCore(
  _opts: ExecuteRunCoreOptions,
): Promise<ExecuteRunCoreResult> {
  throw new Error("executeRunCore not implemented");
}
