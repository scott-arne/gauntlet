import type { VetResult } from "../lib/api";

interface RunsListProps {
  results: VetResult[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pass: "bg-green-100 text-green-800",
    fail: "bg-red-100 text-red-800",
    investigate: "bg-yellow-100 text-yellow-800",
  };
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
        colors[status] || "bg-panel text-slate"
      }`}
    >
      {status}
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

export function RunsList({ results, selectedId, onSelect }: RunsListProps) {
  if (results.length === 0) {
    return <div className="p-3 text-sm text-slate">No runs yet</div>;
  }

  return (
    <div className="flex flex-col">
      <div className="flex-1 overflow-y-auto">
        {results.map((result) => (
          <button
            key={result.scenario}
            onClick={() => onSelect(result.scenario)}
            className={`w-full text-left px-3 py-2.5 border-b border-edge-light transition-colors duration-150 ${
              selectedId === result.scenario
                ? "bg-teal-wash"
                : "hover:bg-panel"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-medium text-ink leading-snug">
                {result.scenario}
              </span>
              <StatusBadge status={result.status} />
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate">
              <span>{formatDuration(result.duration_ms)}</span>
              {result.observations.length > 0 && (
                <span>
                  {result.observations.length} observation{result.observations.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
