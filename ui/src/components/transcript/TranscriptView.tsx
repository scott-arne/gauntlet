import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranscript } from "../../hooks/useTranscript";
import { useLiveTranscript } from "../../hooks/useLiveTranscript";
import { api, type VetResult } from "../../lib/api";
import type { TranscriptModel } from "../../lib/transcript";
import { parseRunId, formatRunTimestamp } from "../../lib/runId";
import { Spinner } from "../shared";
import { Transcript } from "./Transcript";
import { ArtifactDrawer } from "./ArtifactDrawer";
import type { Observation } from "./RunEndPanel";
import "../../styles/transcript.css";

interface Props {
  mode: "posthoc" | "live";
  /** Override the URL :id param — used in static/offline contexts where
   *  there is no router match with a run id. */
  runId?: string;
}

export function TranscriptView({ mode, runId: runIdProp }: Props) {
  const { id: paramRunId } = useParams();
  const runId = runIdProp ?? paramRunId;
  const [artifactPath, setArtifactPath] = useState<string | null>(null);

  if (!runId) return <div style={{ padding: 24 }}>No run selected.</div>;

  return mode === "posthoc"
    ? <PosthocView runId={runId} artifactPath={artifactPath} onOpen={setArtifactPath} onClose={() => setArtifactPath(null)} />
    : <LiveView runId={runId} artifactPath={artifactPath} onOpen={setArtifactPath} onClose={() => setArtifactPath(null)} />;
}

interface InnerProps {
  runId: string;
  artifactPath: string | null;
  onOpen: (p: string) => void;
  onClose: () => void;
}

function PosthocView({ runId, artifactPath, onOpen, onClose }: InnerProps) {
  const { model, loading, error } = useTranscript(runId);
  const [result, setResult] = useState<VetResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.results.get(runId)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => { /* non-fatal — verdict pane will just lack observations */ });
    return () => { cancelled = true; };
  }, [runId]);

  if (loading) {
    return <Container runId={runId}><div style={{ padding: 24 }}><Spinner label="Loading transcript..." /></div></Container>;
  }
  if (error === "not-found") {
    return <Container runId={runId}><NoTranscript runId={runId} /></Container>;
  }
  if (error) {
    return <Container runId={runId}><div style={{ padding: 24, color: "#a33" }}>Failed to load transcript ({error}).</div></Container>;
  }
  if (!model) return null;

  const observations = result?.observations ?? [];

  return (
    <Container runId={runId} result={result}>
      <Transcript
        runId={runId}
        model={model}
        currentTurn={null}
        activeArtifact={artifactPath}
        onOpenArtifact={onOpen}
        observations={observations}
      />
      <ArtifactDrawer runId={runId} path={artifactPath} onClose={onClose} />
    </Container>
  );
}

function LiveView({ runId, artifactPath, onOpen, onClose }: InnerProps) {
  const { model, connected, error } = useLiveTranscript(runId);
  const [observations, setObservations] = useState<Observation[]>([]);

  // Once we see a run_end, fetch the result.json for observations.
  useEffect(() => {
    if (!model.runEnd) return;
    let cancelled = false;
    api.results.get(runId)
      .then((r) => { if (!cancelled) setObservations(r.observations ?? []); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [runId, model.runEnd]);

  const currentTurn = detectCurrentTurn(model);

  return (
    <Container runId={runId} live connected={connected}>
      {error && (
        <div style={{ padding: "12px 24px", background: "#fee", color: "#a33", fontSize: 13 }}>
          {error}
        </div>
      )}
      {model.ordered.length === 0 ? (
        <div style={{ padding: 24 }}>
          <Spinner label={connected ? "Waiting for run_start..." : "Connecting..."} />
        </div>
      ) : (
        <Transcript
          runId={runId}
          model={model}
          currentTurn={currentTurn}
          activeArtifact={artifactPath}
          onOpenArtifact={onOpen}
          observations={observations}
        />
      )}
      <ArtifactDrawer runId={runId} path={artifactPath} onClose={onClose} />
    </Container>
  );
}

/** The current turn is the highest-numbered turn whose llm_response has
 *  arrived; if that turn has any tool whose result is still missing, that
 *  turn is the active one; otherwise the next turn is pending.
 *  Returns null if no turns have responded yet.
 */
function detectCurrentTurn(model: TranscriptModel): number | null {
  if (model.runEnd) return null; // no current turn once the run is over
  const turnNumbers = Array.from(model.turns.keys()).sort((a, b) => b - a);
  if (turnNumbers.length === 0) return null;
  const latest = turnNumbers[0];
  return latest;
}

function Container({
  runId,
  result,
  live,
  connected,
  children,
}: {
  runId: string;
  result?: VetResult | null;
  live?: boolean;
  connected?: boolean;
  children: React.ReactNode;
}) {
  const parsed = parseRunId(runId);
  const cardId = result?.scenario ?? parsed?.cardId ?? runId;
  const when = formatRunTimestamp(runId);
  const status = result?.status;

  return (
    <div style={{ background: "var(--tr-surface, #f7f7f5)", minHeight: "100%" }}>
      <div
        className="flex items-center justify-between p-4 border-b border-edge bg-white"
        style={{ position: "sticky", top: 0, zIndex: 5 }}
      >
        <div>
          <div style={{ fontFamily: "Fraunces, serif", fontStyle: "italic", fontSize: 20 }}>
            {cardId}
          </div>
          <div style={{ color: "var(--tr-slate, #6a7788)", fontSize: 12, marginTop: 2 }}>
            {live ? (
              <>
                <span style={{ color: connected ? "var(--tr-teal, #1a6b5a)" : "var(--tr-slate, #6a7788)" }}>
                  {connected ? "● live" : "○ connecting"}
                </span>
                {when && <> · {when}</>}
              </>
            ) : (
              when ?? ""
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {status && (
            <span
              className={`text-sm px-2 py-1 rounded ${
                status === "pass" ? "bg-green-100 text-green-800" :
                status === "fail" ? "bg-red-100 text-red-800" :
                status === "errored" ? "bg-red-100 text-red-800" :
                "bg-yellow-100 text-yellow-800"
              }`}
            >
              {status === "errored" ? "interrupted" : status}
            </span>
          )}
          <Link
            to={live ? `/runs/live/${runId}` : `/runs/${runId}`}
            style={{ color: "var(--tr-teal, #1a6b5a)", fontSize: 12 }}
          >
            ← back to {live ? "live" : "detail"} view
          </Link>
        </div>
      </div>

      {children}
    </div>
  );
}

function NoTranscript({ runId }: { runId: string }) {
  return (
    <div style={{ padding: "48px 24px", textAlign: "center", maxWidth: 600, margin: "0 auto" }}>
      <div
        style={{
          fontFamily: "Fraunces, serif",
          fontStyle: "italic",
          fontSize: 22,
          color: "var(--tr-slate, #6a7788)",
          marginBottom: 12,
        }}
      >
        No transcript available
      </div>
      <p style={{ color: "var(--tr-slate, #6a7788)", fontSize: 14 }}>
        This run predates the expanded run.jsonl format, or has no events yet.
      </p>
      <Link to={`/runs/${runId}`} style={{ color: "var(--tr-teal, #1a6b5a)", fontSize: 13 }}>
        ← back to run detail
      </Link>
    </div>
  );
}
