import { useEffect, useRef, useState } from "react";
import {
  applyEvent,
  emptyTranscript,
  type TranscriptEvent,
  type TranscriptModel,
} from "../lib/transcript";

// WS message shapes consumed by the transcript view. The server also sends
// `snapshot` / `frame` / `progress` / `complete` / `error` / `gone` messages
// (consumed by LiveRun) — those are ignored here.
type TranscriptWsMessage =
  | { type: "transcriptSnapshot"; events: TranscriptEvent[] }
  | { type: "event"; event: TranscriptEvent }
  | { type: string; [k: string]: unknown };

export interface UseLiveTranscriptResult {
  model: TranscriptModel;
  connected: boolean;
  error: string | null;
  /** True once the server has told us the run is no longer active. */
  gone: boolean;
}

export function useLiveTranscript(runId: string | null): UseLiveTranscriptResult {
  const [model, setModel] = useState<TranscriptModel>(() => emptyTranscript());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!runId) return;
    setModel(emptyTranscript());
    setConnected(false);
    setError(null);
    setGone(false);

    let cancelled = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws?run=${encodeURIComponent(runId)}`);
    wsRef.current = ws;

    ws.onopen = () => { if (!cancelled) setConnected(true); };
    ws.onclose = () => { if (!cancelled) setConnected(false); };
    ws.onerror = () => { if (!cancelled) setConnected(false); };

    ws.onmessage = (evt) => {
      if (cancelled) return;
      let msg: TranscriptWsMessage;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "transcriptSnapshot":
          setModel((m) => (msg as { type: "transcriptSnapshot"; events: TranscriptEvent[] }).events.reduce(applyEvent, m));
          break;
        case "event":
          setModel((m) => applyEvent(m, (msg as { type: "event"; event: TranscriptEvent }).event));
          break;
        case "error": {
          const m = (msg as unknown as { message?: unknown }).message;
          setError(typeof m === "string" ? m : "run error");
          break;
        }
        case "gone":
          setGone(true);
          break;
        default:
          // Ignore legacy message types (frame/progress/snapshot/complete) —
          // they're consumed by LiveRun's hook, not here.
          break;
      }
    };

    return () => {
      cancelled = true;
      ws.close();
      wsRef.current = null;
    };
  }, [runId]);

  return { model, connected, error, gone };
}
