// Bump when result.json format changes in a way downstream consumers must notice.
// Documented in docs/format.md.
//
// v2: added optional `config` block capturing the per-run knobs (target,
//     model, adapter, chrome, turns) so the UI can offer a "Run again"
//     action without re-eliciting the parameters.
export const RESULT_SCHEMA_VERSION = 2;

export interface RunConfigSnapshot {
  target: string;
  model: string;
  adapter: "web" | "cli" | "tui";
  /** `host:port`, omitted when the adapter auto-launched Chrome. */
  chrome?: string;
  turns: number;
  /** CSS-pixel viewport the browsing tab was pinned to. */
  viewport?: { width: number; height: number };
}

export type VetStatus = "pass" | "fail" | "investigate";

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
  evidence: {
    screenshots: string[];
    log: string;
    video?: string;
    artifacts?: string[];
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
}

export interface ModelConfig {
  agent: string;
  fanout?: string;
}
