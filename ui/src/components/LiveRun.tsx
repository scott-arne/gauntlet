import { useRunStream } from "../hooks/useRunStream";
import { useEffect, useRef } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { type ActiveRun } from "../lib/api";
import { parseRunId } from "../lib/runId";
import { Spinner } from "./shared";

interface LiveRunProps {
  activeRuns: ActiveRun[];
  /** True once we've heard back from GET /api/runs/active at least once. */
  activeRunsLoaded: boolean;
  onComplete: (runId: string) => void;
}

export function LiveRun({ activeRuns, activeRunsLoaded, onComplete }: LiveRunProps) {
  // Route path is /runs/live/:id but the value is semantically a runId
  // (composite key: `<cardId>_<ts>_<nonce>`).
  const { id: runId } = useParams();
  const navigate = useNavigate();
  const { frame, messages, result, connected, error, gone } = useRunStream(runId ?? null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (result && runId) onComplete(runId);
  }, [result, runId, onComplete]);

  if (!runId) return <Navigate to="/runs" replace />;

  // If we know the active-runs list has loaded and this runId isn't there
  // *and* the server said `gone` without a result, fall through to the
  // finished-run detail page.
  const active = activeRuns.find((r) => r.id === runId);
  // Prefer the server-provided title; fall back to the cardId extracted
  // from the runId so we never render a full composite key as the heading.
  const title = active?.title ?? parseRunId(runId)?.cardId ?? runId;

  if (activeRunsLoaded && !active && gone && !result) {
    // Run isn't active and we couldn't load a result — bounce home.
    return <Navigate to={`/runs/${runId}`} replace />;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-edge bg-white">
        <div>
          <h2 className="heading-display text-lg">{title}</h2>
          <span className={`text-xs ${connected ? "text-teal" : "text-slate"}`}>
            {connected ? "Connected" : "Connecting..."}
          </span>
        </div>
        {result && (
          <span className={`text-sm px-2 py-1 rounded ${
            result.status === "pass" ? "bg-green-100 text-green-800" :
            result.status === "fail" ? "bg-red-100 text-red-800" :
            "bg-yellow-100 text-yellow-800"
          }`}>
            {result.status}
          </span>
        )}
      </div>

      {error && (
        <div className="mx-4 mt-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3">
          <h3 className="text-sm font-medium text-red-800">Run error</h3>
          <p className="text-sm text-red-700 mt-1">{error}</p>
          <button
            className="btn-secondary mt-3"
            onClick={() => navigate("/runs")}
          >
            Back to Runs
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 bg-ink flex items-center justify-center p-2 min-h-0">
          {frame ? (
            <img src={frame} alt="Browser view" className="max-w-full max-h-full object-contain rounded" />
          ) : activeRunsLoaded && !active ? (
            <div className="text-slate text-sm">Run not found</div>
          ) : (
            <Spinner label="Waiting for browser..." />
          )}
        </div>

        <div
          ref={logRef}
          className="h-48 flex-shrink-0 overflow-y-auto border-t border-edge bg-white p-3 font-mono text-xs"
        >
          {messages.length === 0 && <div className="text-slate">Waiting for output...</div>}
          {messages.map((msg, i) => (
            <div key={i} className="text-ink-light whitespace-pre-wrap">{msg}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
