import { type ReactNode, useState, useEffect, useCallback } from "react";
import { api, type ErrorEntry } from "../lib/api";

interface AppShellProps {
  sidebar: ReactNode;
  children: ReactNode;
}

export function AppShell({ sidebar, children }: AppShellProps) {
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [showErrors, setShowErrors] = useState(false);

  const refreshErrors = useCallback(() => {
    api.errors.list().then(setErrors).catch(() => {});
  }, []);

  useEffect(() => {
    refreshErrors();
    const interval = setInterval(refreshErrors, 10000);
    return () => clearInterval(interval);
  }, [refreshErrors]);

  return (
    <div className="flex h-screen flex-col bg-surface">
      <header className="flex items-center justify-between border-b border-edge bg-white px-4 py-2">
        <h1 className="heading-display text-lg">gauntlet</h1>
        <button
          className="relative flex items-center gap-1.5 text-sm text-slate hover:text-ink transition-colors"
          onClick={() => { setShowErrors(!showErrors); refreshErrors(); }}
        >
          Errors
          {errors.length > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {errors.length}
            </span>
          )}
        </button>
      </header>

      {showErrors && (
        <div className="absolute top-10 right-4 z-50 w-96 max-h-80 overflow-y-auto rounded-lg border border-edge bg-white shadow-lg">
          <div className="flex items-center justify-between px-4 py-2 border-b border-edge">
            <h3 className="text-sm font-medium text-ink">Error Log</h3>
            <button
              className="text-xs text-slate hover:text-ink"
              onClick={() => setShowErrors(false)}
            >
              Close
            </button>
          </div>
          {errors.length === 0 ? (
            <div className="p-4 text-sm text-slate">No errors recorded.</div>
          ) : (
            <ul className="divide-y divide-edge">
              {errors.map((err) => (
                <li key={`${err.timestamp}-${err.source}`} className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">{err.source}</span>
                    <span className="text-[10px] text-slate">{new Date(err.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className="text-xs text-ink mt-0.5 break-words">{err.message}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <aside className="w-72 flex-shrink-0 border-r border-edge bg-white overflow-y-auto">
          {sidebar}
        </aside>
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
