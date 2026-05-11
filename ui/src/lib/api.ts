export interface CardSummary {
  id: string;
  title: string;
  status: string;
  tags: string[];
  parent?: string;
}

export interface CardDetail {
  id: string;
  title: string;
  status: string;
  tags: string[];
  parent?: string;
  stakeholder?: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface RunConfigSnapshot {
  target: string;
  model: string;
  adapter: "web" | "cli" | "tui";
  chrome?: string;
  budgetMs: number;
  maxStuckRetries: number;
  viewport?: { width: number; height: number };
}

export interface VetResult {
  schemaVersion: number;
  /**
   * Primary key for this run: `<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>`. Matches
   * the on-disk results directory name and the active-runs registry key.
   */
  runId: string;
  /** The cardId this run tested. Retained as `scenario` for back-compat. */
  scenario: string;
  status: "pass" | "fail" | "investigate";
  summary: string;
  reasoning: string;
  observations: { kind: string; description: string; evidence?: string[] }[];
  evidence: { screenshots: string[]; log: string; video?: string };
  duration_ms: number;
  usage?: { inputTokens: number; outputTokens: number; turns: number };
  /** Present on v2+ results. Undefined on older results on disk. */
  config?: RunConfigSnapshot;
  runSet?: {
    runSetId: string;
    kind: "single" | "batch";
    passes: number;
    cards: string[];
    cardIndex: number;
    attemptNumber: number;
  };
}

export interface RunSetSummary {
  perCard: Array<{
    cardId: string;
    passes: number;
    byStatus: { pass: number; fail: number; investigate: number; errored: number; cancelled: number };
    cardStatus: string;
    medianTurns: number;
    medianDurationMs: number;
  }>;
  overall: {
    totalRuns: number;
    byStatus: { pass: number; fail: number; investigate: number; errored: number; cancelled: number };
    overallStatus: string;
  };
}

export interface RunSetManifest {
  schemaVersion: 1;
  runSetId: string;
  kind: "single" | "batch";
  createdAt: string;
  completedAt: string | null;
  passes: number;
  cards: string[];
  runs: Array<{ runId: string; cardId: string; attemptNumber: number; status: string }>;
  summary: RunSetSummary | null;
}

export interface StartRunResponse {
  runSetId: string | null;
  kind: "single" | "batch";
  passes: number;
  runs: Array<{ runId: string; attemptNumber: number; status: "queued" | "running" }>;
}

/** Paginated `GET /api/results` response. */
export interface ResultsPage {
  results: VetResult[];
  total: number;
  limit: number;
  offset: number;
}

export interface FanoutResult {
  parent: string;
  generated: { id: string; title: string; filename: string }[];
}

export interface ActiveRun {
  /**
   * Primary key for the run: `<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>`. Use
   * this to subscribe to the WS channel or fetch the on-disk result.
   */
  id: string;
  /** Card this run is exercising. Use for grouping/display, not routing. */
  cardId: string;
  title: string;
  target: string;
  model: string;
  startedAt: number;
}

export interface RunSnapshot {
  info: ActiveRun;
  lastFrame: { data: string; width: number; height: number } | null;
  progressLog: string[];
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

export interface ServerConfig {
  models: string[];
  defaultModel: string | null;
  defaultTarget: string | null;
  defaultBudgetMs: number;
  defaultMaxStuckRetries: number;
  defaultViewport: { width: number; height: number };
  /**
   * Server's default for "persist screencast frames to disk". The UI
   * prefills the NewRunModal checkbox from this, so a server run with
   * `--save-screencast` ticks the box by default. The live WS stream is
   * unaffected — this flag only gates the disk writer.
   */
  defaultSaveScreencast: boolean;
}

export interface ErrorEntry {
  timestamp: string;
  source: string;
  message: string;
}

export const api = {
  config: {
    get: () => request<ServerConfig>("/config"),
  },
  errors: {
    list: () => request<{ errors: ErrorEntry[] }>("/errors").then((r) => r.errors),
  },
  cards: {
    list: () => request<CardSummary[]>("/scenarios"),
    get: (id: string) => request<CardDetail>(`/scenarios/${id}`),
    update: (id: string, data: Partial<CardDetail>) =>
      request<CardDetail>(`/scenarios/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    approve: (id: string) =>
      request<CardDetail>(`/scenarios/${id}/approve`, { method: "POST" }),
    create: (data: Omit<CardDetail, "acceptanceCriteria"> & { acceptanceCriteria?: string[] }) =>
      request<CardDetail>("/scenarios", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<void>(`/scenarios/${id}`, { method: "DELETE" }),
  },
  results: {
    // Paginated listing. See `GET /api/results` in src/api/routes/results.ts.
    // Server clamps `limit` to [1,200] and `offset` to ≥0; callers can pass
    // a raw user intent without guarding. `cardId` narrows to a single
    // card's run history.
    list: (params?: { limit?: number; offset?: number; cardId?: string }) => {
      const q = new URLSearchParams();
      if (params?.limit !== undefined) q.set("limit", String(params.limit));
      if (params?.offset !== undefined) q.set("offset", String(params.offset));
      if (params?.cardId) q.set("cardId", params.cardId);
      const qs = q.toString();
      return request<ResultsPage>(`/results${qs ? `?${qs}` : ""}`);
    },
    get: (runId: string) => request<VetResult>(`/results/${runId}`),
    // Build a URL for any file inside a run directory, given the relative
    // path stored in the manifest (e.g. "screenshots/001.png", "run.jsonl").
    // This is the one place in the FE that turns a manifest path into a URL.
    // The path segment is a runId (directory name under .gauntlet/results/),
    // not a cardId.
    fileUrl: (runId: string, relPath: string) =>
      `/api/results/${encodeURIComponent(runId)}/file/${relPath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    // Fetch the text contents of a file listed in a run's manifest.
    // Used by the transcript view (run.jsonl) and the artifact drawer.
    fileText: async (runId: string, relPath: string): Promise<string> => {
      const res = await fetch(api.results.fileUrl(runId, relPath));
      if (res.status === 404) throw new Error("not-found");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.text();
    },
  },
  fanout: {
    // `generate` takes a cardId — it fans out a card into related variations
    // without needing a run to exist.
    generate: (cardId: string) =>
      request<FanoutResult>(`/fanout/${cardId}`, { method: "POST" }),
    // These two key off an on-disk run result, so the path segment is a
    // runId (results directory name) — not a cardId.
    fromObservations: (runId: string) =>
      request<FanoutResult>(`/fanout/${runId}/observations`, { method: "POST" }),
    fromFailure: (runId: string) =>
      request<FanoutResult>(`/fanout/${runId}/failure`, { method: "POST" }),
  },
  run: {
    start: (cardId: string, body: {
      target: string;
      model?: string;
      adapter?: string;
      chrome?: string;
      viewport?: { width: number; height: number };
      saveScreencast?: boolean;
      passes?: number;
    }) =>
      request<StartRunResponse>(`/run/${cardId}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    cancel: (runId: string) =>
      request<{ status: "cancelling" }>(`/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }),
  },
  runSets: {
    get: (runSetId: string) =>
      request<RunSetManifest>(`/run-sets/${encodeURIComponent(runSetId)}`),
    summary: (runSetId: string) =>
      request<RunSetSummary>(`/run-sets/${encodeURIComponent(runSetId)}/summary`),
    cancel: (runSetId: string) =>
      request<{ status: "cancelling" }>(`/run-sets/${encodeURIComponent(runSetId)}`, { method: "DELETE" }),
  },
  activeRuns: {
    list: () => request<{ runs: ActiveRun[] }>("/runs/active").then((r) => r.runs),
    snapshot: (runId: string) =>
      request<RunSnapshot>(`/runs/active/${encodeURIComponent(runId)}/snapshot`),
  },
};
