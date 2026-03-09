export function StatusBadge({
  status,
  size = "sm",
}: {
  status: string;
  size?: "sm" | "md";
}) {
  const colors: Record<string, string> = {
    pass: "bg-green-100 text-green-800",
    fail: "bg-red-100 text-red-800",
    investigate: "bg-yellow-100 text-yellow-800",
    ready: "bg-teal-wash text-teal-dark",
    draft: "bg-panel text-slate",
  };
  const sizeClass = size === "md" ? "px-2 py-1 text-sm" : "px-1.5 py-0.5 text-xs";
  return (
    <span
      className={`inline-block rounded ${sizeClass} font-medium ${
        colors[status] || "bg-panel text-slate"
      }`}
    >
      {status}
    </span>
  );
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}
