// Bump when result.json format changes in a way downstream consumers must notice.
// Documented in docs/format.md.
export const RESULT_SCHEMA_VERSION = 1;

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
  };
  duration_ms: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    turns: number;
  };
}

export interface ModelConfig {
  agent: string;
  fanout?: string;
}
