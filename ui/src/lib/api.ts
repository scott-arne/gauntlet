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

export interface VetResult {
  schemaVersion: number;
  scenario: string;
  status: "pass" | "fail" | "investigate";
  summary: string;
  reasoning: string;
  observations: { kind: string; description: string; evidence?: string[] }[];
  evidence: { screenshots: string[]; log: string; video?: string };
  duration_ms: number;
  usage?: { inputTokens: number; outputTokens: number; turns: number };
}

export interface FanoutResult {
  parent: string;
  generated: { id: string; title: string; filename: string }[];
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
    list: () => request<VetResult[]>("/results"),
    get: (id: string) => request<VetResult>(`/results/${id}`),
    // Build a URL for any file inside a run directory, given the relative
    // path stored in the manifest (e.g. "screenshots/001.png", "run.jsonl").
    // This is the one place in the FE that turns a manifest path into a URL.
    fileUrl: (scenario: string, relPath: string) =>
      `/api/results/${encodeURIComponent(scenario)}/file/${relPath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
  },
  fanout: {
    generate: (id: string) =>
      request<FanoutResult>(`/fanout/${id}`, { method: "POST" }),
    fromObservations: (id: string) =>
      request<FanoutResult>(`/fanout/${id}/observations`, { method: "POST" }),
    fromFailure: (id: string) =>
      request<FanoutResult>(`/fanout/${id}/failure`, { method: "POST" }),
  },
  run: {
    start: (id: string, body: { target: string; model?: string; adapter?: string; chrome?: string }) =>
      request<VetResult>(`/run/${id}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
};
