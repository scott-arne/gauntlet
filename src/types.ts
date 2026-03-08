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
  scenario: string;
  status: VetStatus;
  summary: string;
  reasoning: string;
  observations: Observation[];
  evidence: {
    screenshots: string[];
    log: string;
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
