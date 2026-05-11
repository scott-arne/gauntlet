import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type VetResult, type FanoutResult } from "../lib/api";
import type { NewRunPrefill } from "./NewRunModal";
import { StatusBadge, formatDuration } from "./shared";
import { formatRunTimestamp } from "../lib/runId";

interface RunDetailProps {
  result: VetResult;
  onFanout: () => void;
  onRunAgain?: (prefill: NewRunPrefill) => void;
}

export function RunDetail({ result, onFanout, onRunAgain }: RunDetailProps) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<FanoutResult["generated"] | null>(null);

  // Fanout from observations/failure reads the result.json under
  // .gauntlet/results/<runId>/, so this path segment must be the runId.
  async function handleFromObservations() {
    try {
      setActing(true);
      setError(null);
      setGenerated(null);
      const res = await api.fanout.fromObservations(result.runId);
      setGenerated(res.generated);
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
      setGenerated(null);
      const res = await api.fanout.fromFailure(result.runId);
      setGenerated(res.generated);
      onFanout();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to analyze failure");
    } finally {
      setActing(false);
    }
  }

  const when = formatRunTimestamp(result.runId);

  return (
    <div className="p-6 max-w-3xl">
      <div className={`flex items-center gap-3 ${when ? "mb-2" : "mb-6"}`}>
        <h1 className="heading-display text-2xl">{result.scenario}</h1>
        <StatusBadge status={result.status} size="md" />
        <Link
          to={`/runs/${result.runId}/transcript`}
          className="text-xs text-teal hover:underline ml-auto"
        >
          View transcript →
        </Link>
      </div>
      {when && (
        <p className="text-sm text-slate mb-6">Run at {when}</p>
      )}

      {result.runSet && (
        <div className="mb-3 text-sm">
          Part of run set{" "}
          <Link to={`/run-sets/${result.runSet.runSetId}`} className="text-teal underline">
            {result.runSet.runSetId}
          </Link>
          {" — attempt "}{result.runSet.attemptNumber} of {result.runSet.passes}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {generated && generated.length > 0 && (
        <div className="mb-4 rounded-lg bg-green-50 border border-green-200 px-4 py-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-green-800">
              Generated {generated.length} test card{generated.length !== 1 ? "s" : ""}
            </h3>
            <button
              className="text-xs text-green-600 hover:text-green-800"
              onClick={() => setGenerated(null)}
            >
              Dismiss
            </button>
          </div>
          <ul className="mt-2 space-y-1">
            {generated.map((card) => (
              <li key={card.id} className="text-sm text-green-700">
                <a href={`/cards/${card.id}`} className="hover:underline font-medium">{card.title}</a>
                <span className="text-green-500 ml-1">({card.id})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Video playback is not yet wired up — the writer records screencast
          frames under frames/ but does not stitch them into a video. When that
          lands, add the video to result.json's evidence manifest and render it
          via api.results.fileUrl(). See docs/format.md. */}

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
              {result.evidence.screenshots.map((relPath) => (
                <img
                  key={relPath}
                  src={api.results.fileUrl(result.runId, relPath)}
                  alt={relPath}
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
          {onRunAgain && result.config && (
            <button
              className="btn-secondary"
              onClick={() => onRunAgain({
                cardId: result.scenario,
                target: result.config!.target,
                model: result.config!.model,
                chrome: result.config!.chrome,
                adapter: result.config!.adapter,
                viewport: result.config!.viewport,
                passes: result.runSet?.passes,
              })}
            >
              Run Again
            </button>
          )}
          {result.observations.length > 0 && (
            <button
              className="btn-primary"
              onClick={handleFromObservations}
              disabled={acting}
            >
              {acting ? "Generating..." : "Generate Test Cards from Observations"}
            </button>
          )}
          {result.status === "fail" && (
            <button
              className="btn-secondary"
              onClick={handleAnalyzeFailure}
              disabled={acting}
            >
              {acting ? "Generating..." : "Generate Test Cards from Failure"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
