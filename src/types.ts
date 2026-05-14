// Bump when result.json format changes in a way downstream consumers must notice.
// Documented in docs/format.md.
//
// v2: added optional `config` block capturing the per-run knobs (target,
//     model, adapter, chrome, budgetMs) so the UI can offer a "Run again"
//     action without re-eliciting the parameters.
// v3: RunConfigSnapshot.turns replaced with budgetMs (wall-clock budget
//     in ms) and maxStuckRetries (prompt-injected stuck-retry hint).
//     Reflects the time-budget loop replacing maxTurns. See
//     docs/superpowers/specs/2026-05-11-time-budget-and-stuck-detection-spec.md.
// v4: Removed maxStuckRetries (the stuck-handling system-prompt block it
//     templated into has been retired in favor of mid-loop reflection
//     checkpoints — see docs/reflection-checkpoints-spec.md, PRI-1569).
// v5: Added "errored" to VetStatus and optional error: {type, message}
//     field on VetResult. Today's only emitter is shutdown drain
//     (PRI-1507) — type is "shutdown_interrupted". The error.type field
//     is open-typed (string) so additive new categories don't require a
//     schema bump or TypeScript widening; consumers MUST tolerate
//     unknown types. For shutdown-stub results (the floor-of-quality
//     fallback when even the post-abort patience window expires),
//     duration_ms uses -1 as a sentinel meaning "registry entry was
//     missing startedAt at stub time".
export const RESULT_SCHEMA_VERSION = 5;

import type { RunSetCtx } from "./runs/run-set-types";

export interface RunConfigSnapshot {
  target: string;
  model: string;
  adapter: "web" | "cli" | "tui";
  /** `host:port`, omitted when the adapter auto-launched Chrome. */
  chrome?: string;
  /** Wall-clock budget in ms that this run was launched with. */
  budgetMs: number;
  /**
   * Viewport this run actually used, reported by the adapter. Units are
   * adapter-dependent: CSS pixels for web, character cells for tui.
   * Omitted when the adapter has no rendering surface (cli).
   */
  viewport?: { width: number; height: number };
}

export type VetStatus = "pass" | "fail" | "investigate" | "errored";

export type ObservationKind =
  | "bug"
  | "ux"
  | "typo"
  | "suggestion"
  | "a11y"
  | "performance";

export interface Observation {
  kind: ObservationKind;
  description: string;
  evidence?: string[];
}

export interface VetResult {
  schemaVersion: number;
  /**
   * Self-describing primary key for the run, set by the caller (route or
   * CLI) before writing. Shape: `<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>`.
   * `scenario` (the cardId) is retained for back-compat readers.
   */
  runId: string;
  scenario: string;
  status: VetStatus;
  summary: string;
  reasoning: string;
  observations: Observation[];
  /**
   * Set when `status === "errored"`. Categorizes the cause so consumers
   * can distinguish shutdown interruption from other future error
   * surfaces. `type` is open-typed (string) so additive new categories
   * don't require a schema bump or TypeScript type widening — consumers
   * MUST tolerate unknown `type` values. Today the only emitted type is
   * `"shutdown_interrupted"` (PRI-1507).
   */
  error?: { type: string; message: string };
  evidence: {
    screenshots: string[];
    log: string;
    video?: string;
    artifacts?: string[];
    /**
     * TUI screen captures, one per `read_screen` tool call. Each entry is
     * a path to the raw `.ansi` file; the parsed `.json` twin lives at
     * the same stem (e.g. `captures/003.ansi` + `captures/003.json`).
     * Omitted entirely for non-TUI runs.
     */
    captures?: string[];
  };
  duration_ms: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /**
     * Tokens written to Anthropic's prompt cache across the whole run.
     * Omitted when 0 or when the provider doesn't surface the metric
     * (e.g. OpenAI today).
     */
    cacheCreationInputTokens?: number;
    /**
     * Tokens served from Anthropic's prompt cache across the whole run.
     * A non-zero value means the cache breakpoints in anthropic.ts are
     * actually hitting.
     */
    cacheReadInputTokens?: number;
    turns: number;
  };
  /**
   * Knobs the run was launched with. Optional for back-compat with v1
   * results on disk. Used by the UI to offer "Run again" without
   * re-asking the user for params.
   */
  config?: RunConfigSnapshot;
  runSet?: RunSetCtx;
}

export interface ModelConfig {
  agent: string;
  fanout?: string;
}
