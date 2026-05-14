import type { RunEndEvent } from "../../lib/transcript";

export interface Observation {
  kind: string;
  description: string;
}

interface Props {
  runEnd: RunEndEvent;
  observations: Observation[];
}

function splitObservations(obs: Observation[]) {
  const limitations: Observation[] = [];
  const suggestions: Observation[] = [];
  const notes: Observation[] = [];
  for (const o of obs) {
    const k = o.kind.toLowerCase();
    if (k === "bug") limitations.push(o);
    else if (k === "suggestion" || k === "ux") suggestions.push(o);
    else notes.push(o);
  }
  return { limitations, suggestions, notes };
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}

export function RunEndPanel({ runEnd, observations }: Props) {
  const { limitations, suggestions, notes } = splitObservations(observations);
  // PRI-1507: treat errored verdicts visually like fail (red treatment),
  // but render the label as "Interrupted" rather than the literal status
  // so operators see the cause at a glance.
  const isFail = runEnd.status === "fail" || runEnd.status === "errored";
  const verdictLabel = runEnd.status === "errored"
    ? "Interrupted"
    : runEnd.status.charAt(0).toUpperCase() + runEnd.status.slice(1);

  return (
    <section className={`tr-run-end${isFail ? " tr-fail" : ""}`}>
      <header className="tr-run-end-head">
        <div>
          <div style={{ fontFamily: "Fraunces, serif", fontStyle: "italic", fontSize: "24px", marginBottom: "4px" }}>
            Verdict — {verdictLabel}
          </div>
        </div>
        <div className="tr-run-end-timing">
          {formatDurationMs(runEnd.durationMs)} · {runEnd.usage.turns} turn{runEnd.usage.turns !== 1 ? "s" : ""} ·
          {" "}{runEnd.usage.inputTokens.toLocaleString()} in ·
          {" "}{runEnd.usage.outputTokens.toLocaleString()} out
        </div>
      </header>

      <div className="tr-run-end-summary">{runEnd.summary}</div>

      {runEnd.reasoning && (
        <div className="tr-run-end-reasoning" style={{ whiteSpace: "pre-wrap" }}>
          {runEnd.reasoning}
        </div>
      )}

      {limitations.length > 0 && (
        <ObservationGroup title="Limitations" items={limitations} tone="danger" />
      )}
      {suggestions.length > 0 && (
        <ObservationGroup title="Suggestions" items={suggestions} tone="neutral" />
      )}
      {notes.length > 0 && (
        <ObservationGroup title="Notes" items={notes} tone="neutral" />
      )}
    </section>
  );
}

interface ObservationGroupProps {
  title: string;
  items: Observation[];
  tone: "danger" | "neutral";
}

function ObservationGroup({ title, items, tone }: ObservationGroupProps) {
  return (
    <div style={{ marginTop: "20px" }}>
      <div
        style={{
          fontSize: "11px",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: tone === "danger" ? "var(--tr-red-dark, #8b2a1e)" : "var(--tr-slate)",
          fontWeight: 600,
          marginBottom: "8px",
        }}
      >
        {title}
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {items.map((o, i) => (
          <li key={i} style={{ padding: "6px 0", borderTop: i === 0 ? "none" : "1px dashed var(--tr-edge)" }}>
            <span
              style={{
                display: "inline-block",
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--tr-slate-soft)",
                marginRight: "8px",
              }}
            >
              {o.kind}
            </span>
            <span>{o.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
