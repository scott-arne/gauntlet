import { useState, useEffect, useCallback, useRef } from "react";

export function Spinner({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate">
      <div className="spinner" />
      <span>{label}</span>
    </div>
  );
}

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

// --- Toast ---

export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback((msg: string) => {
    clearTimeout(timerRef.current);
    setMessage(msg);
    timerRef.current = setTimeout(() => setMessage(null), 2000);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { message, show };
}

export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="toast fixed bottom-6 right-6 z-50 rounded-lg bg-ink px-4 py-2.5 text-sm text-white shadow-lg">
      {message}
    </div>
  );
}

// --- Confirm Modal ---

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm bg-white border border-edge rounded-lg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="heading-display text-lg mb-2">{title}</h2>
        <p className="text-sm text-slate mb-5">{message}</p>
        <div className="flex items-center gap-3">
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
