import type { VetResult, ActiveRun } from "../lib/api";
import { StatusBadge, formatDuration } from "./shared";
import { formatRunTimestamp } from "../lib/runId";

interface RunsListProps {
  results: VetResult[];
  activeRuns: ActiveRun[];
  /** The runId of the currently-selected row, if any. */
  selectedId?: string;
  onSelect: (runId: string) => void;
  onSelectActive: (runId: string) => void;
}

export function RunsList({ results, activeRuns, selectedId, onSelect, onSelectActive }: RunsListProps) {
  if (results.length === 0 && activeRuns.length === 0) {
    return (
      <div className="p-3 text-sm text-slate">
        No runs yet. Use the <span className="font-medium text-ink">New Run</span> button above to start one.
      </div>
    );
  }

  // Dedupe completed results against active ones by runId. A run that just
  // finished may appear in both lists for a beat; the active entry wins
  // until the registry drops it.
  const activeRunIds = new Set(activeRuns.map((r) => r.id));
  const completed = results.filter((r) => !activeRunIds.has(r.runId));

  return (
    <div className="flex flex-col">
      <div className="flex-1 overflow-y-auto">
        {activeRuns.map((run) => (
          <button
            key={`active-${run.id}`}
            onClick={() => onSelectActive(run.id)}
            className={`w-full text-left px-3 py-2.5 border-b border-edge-light transition-colors duration-150 ${
              selectedId === run.id ? "bg-teal-wash" : "hover:bg-panel"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-medium text-ink leading-snug truncate">{run.title}</span>
              <span className="relative flex h-2 w-2 mt-1.5 flex-shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-teal" />
              </span>
            </div>
            <div className="mt-0.5 text-xs text-slate">running · {run.cardId}</div>
          </button>
        ))}
        {completed.map((result) => {
          const when = formatRunTimestamp(result.runId);
          return (
            <button
              key={result.runId}
              onClick={() => onSelect(result.runId)}
              className={`w-full text-left px-3 py-2.5 border-b border-edge-light transition-colors duration-150 ${
                selectedId === result.runId ? "bg-teal-wash" : "hover:bg-panel"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium text-ink leading-snug">{result.scenario}</span>
                <StatusBadge status={result.status} />
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-slate">
                {when && <span>{when}</span>}
                <span>{formatDuration(result.duration_ms)}</span>
                {result.observations.length > 0 && (
                  <span>
                    {result.observations.length} observation{result.observations.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
