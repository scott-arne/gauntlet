import { useRunStream } from "../hooks/useRunStream";
import { useEffect, useRef } from "react";

interface LiveRunProps {
  runId: string;
  cardTitle: string;
  error?: string | null;
  onComplete: () => void;
  onBack: () => void;
}

export function LiveRun({ runId, cardTitle, error: startError, onComplete, onBack }: LiveRunProps) {
  const { frame, messages, result, connected } = useRunStream(runId);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (result) onComplete();
  }, [result, onComplete]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-edge bg-white">
        <div>
          <h2 className="heading-display text-lg">{cardTitle}</h2>
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

      {startError && (
        <div className="mx-4 mt-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3">
          <h3 className="text-sm font-medium text-red-800">Run failed to start</h3>
          <p className="text-sm text-red-700 mt-1">{startError}</p>
          <button
            className="btn-secondary mt-3"
            onClick={onBack}
          >
            Back to Runs
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Browser viewport */}
        <div className="flex-1 bg-ink flex items-center justify-center p-2 min-h-0">
          {frame ? (
            <img
              src={frame}
              alt="Browser view"
              className="max-w-full max-h-full object-contain rounded"
            />
          ) : (
            <div className="text-slate text-sm">Waiting for browser...</div>
          )}
        </div>

        {/* LLM output log */}
        <div
          ref={logRef}
          className="h-48 flex-shrink-0 overflow-y-auto border-t border-edge bg-white p-3 font-mono text-xs"
        >
          {messages.length === 0 && (
            <div className="text-slate">Waiting for output...</div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className="text-ink-light whitespace-pre-wrap">
              {msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
