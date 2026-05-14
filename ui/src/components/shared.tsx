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
    // PRI-1507: a run that didn't reach a verdict (today: shutdown
    // interrupted; future: other terminal errors). Red treatment shared
    // with `fail`; label is rendered as "interrupted" rather than the
    // literal "errored" to communicate cause.
    errored: "bg-red-100 text-red-800",
    cancelled: "bg-panel text-slate",
    ready: "bg-teal-wash text-teal-dark",
    draft: "bg-panel text-slate",
  };
  const sizeClass = size === "md" ? "px-2 py-1 text-sm" : "px-1.5 py-0.5 text-xs";
  const label = status === "errored" ? "interrupted" : status;
  return (
    <span
      className={`inline-block rounded ${sizeClass} font-medium ${
        colors[status] || "bg-panel text-slate"
      }`}
    >
      {label}
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

// --- Confirm Dialog (native <dialog>) ---

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const confirmClass = danger
    ? "btn-danger"
    : "btn-primary";

  if (!open) return <dialog ref={dialogRef} />;

  return (
    <dialog
      ref={dialogRef}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="backdrop:bg-ink/40 bg-white border border-edge rounded-lg p-0 max-w-sm w-full"
    >
      <div className="px-5 pt-5 pb-4">
        <h2 className="heading-display text-lg">{title}</h2>
        <p className="text-sm text-slate mt-2 leading-relaxed">{message}</p>
      </div>
      <div className="flex justify-end gap-2 px-5 pb-4">
        <button className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className={confirmClass} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
