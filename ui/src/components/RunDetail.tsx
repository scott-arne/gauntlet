import { useState } from "react";
import { api, type VetResult } from "../lib/api";
import { StatusBadge, formatDuration } from "./shared";

interface RunDetailProps {
  result: VetResult;
  onFanout: () => void;
}

export function RunDetail({ result, onFanout }: RunDetailProps) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFromObservations() {
    try {
      setActing(true);
      setError(null);
      await api.fanout.fromObservations(result.scenario);
      onFanout();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate from observations");
    } finally {
      setActing(false);
    }
  }

  async function handleAnalyzeFailure() {
    try {
      setActing(true);
      setError(null);
      await api.fanout.fromFailure(result.scenario);
      onFanout();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to analyze failure");
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="heading-display text-2xl">{result.scenario}</h1>
        <StatusBadge status={result.status} size="md" />
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <video
        controls
        className="w-full rounded border border-edge mb-4"
        src={`/api/results/${result.scenario}/video`}
        onError={(e) => {
          (e.target as HTMLVideoElement).style.display = "none";
        }}
      />

      <div className="space-y-4">
        <div className="card p-4">
          <h2 className="section-label mb-2">Summary</h2>
          <p className="text-sm text-ink">{result.summary}</p>
        </div>

        <div className="card p-4">
          <h2 className="section-label mb-2">Reasoning</h2>
          <p className="text-sm text-ink whitespace-pre-wrap">{result.reasoning}</p>
        </div>

        {result.observations.length > 0 && (
          <div className="card p-4">
            <h2 className="section-label mb-2">
              Observations ({result.observations.length})
            </h2>
            <ul className="space-y-2">
              {result.observations.map((obs, i) => (
                <li key={i} className="text-sm">
                  <span className="inline-block rounded bg-panel px-1.5 py-0.5 text-xs font-medium text-slate mr-2">
                    {obs.kind}
                  </span>
                  <span className="text-ink">{obs.description}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {result.evidence.screenshots.length > 0 && (
          <div className="card p-4">
            <h2 className="section-label mb-2">Screenshots</h2>
            <div className="grid grid-cols-2 gap-3">
              {result.evidence.screenshots.map((name) => (
                <img
                  key={name}
                  src={`/api/results/${result.scenario}/screenshots/${name}`}
                  alt={name}
                  className="rounded border border-edge"
                />
              ))}
            </div>
          </div>
        )}

        {result.usage && (
          <div className="card p-4">
            <h2 className="section-label mb-2">Usage</h2>
            <div className="flex gap-4 text-sm text-slate">
              <span>Input: {result.usage.inputTokens.toLocaleString()} tokens</span>
              <span>Output: {result.usage.outputTokens.toLocaleString()} tokens</span>
              <span>{result.usage.turns} turn{result.usage.turns !== 1 ? "s" : ""}</span>
            </div>
          </div>
        )}

        <div className="text-xs text-slate">
          Duration: {formatDuration(result.duration_ms)}
        </div>

        <div className="flex items-center gap-3 pt-2">
          {result.observations.length > 0 && (
            <button
              className="btn-primary"
              onClick={handleFromObservations}
              disabled={acting}
            >
              {acting ? "Generating..." : "Generate from Observations"}
            </button>
          )}
          {result.status === "fail" && (
            <button
              className="btn-secondary"
              onClick={handleAnalyzeFailure}
              disabled={acting}
            >
              {acting ? "Analyzing..." : "Analyze Failure"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
