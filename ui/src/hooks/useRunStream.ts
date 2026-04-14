import { useState, useEffect, useRef } from "react";
import { api, type VetResult } from "../lib/api";

type RunMessage =
  | { type: "frame"; data: string; width: number; height: number }
  | { type: "progress"; message: string }
  | { type: "complete"; result: VetResult }
  | { type: "error"; message: string }
  | {
      type: "snapshot";
      lastFrame: { data: string; width: number; height: number } | null;
      progressLog: string[];
    }
  | { type: "gone" };

export interface UseRunStreamResult {
  frame: string | null;
  messages: string[];
  result: VetResult | null;
  connected: boolean;
  error: string | null;
  /** True when the server told us the run is no longer active (and we should fall back to the completed result). */
  gone: boolean;
}

export function useRunStream(runId: string | null): UseRunStreamResult {
  const [frame, setFrame] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [result, setResult] = useState<VetResult | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!runId) return;
    // Reset state whenever runId changes so a fresh mount doesn't leak
    // stale data from a previous run.
    setFrame(null);
    setMessages([]);
    setResult(null);
    setError(null);
    setGone(false);

    let cancelled = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws?run=${runId}`);
    wsRef.current = ws;

    ws.onopen = () => { if (!cancelled) setConnected(true); };
    ws.onclose = () => { if (!cancelled) setConnected(false); };
    ws.onerror = () => { if (!cancelled) setConnected(false); };

    ws.onmessage = (event) => {
      if (cancelled) return;
      let msg: RunMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "snapshot":
          if (msg.lastFrame) {
            setFrame(`data:image/jpeg;base64,${msg.lastFrame.data}`);
          }
          setMessages(msg.progressLog);
          break;
        case "frame":
          setFrame(`data:image/jpeg;base64,${msg.data}`);
          break;
        case "progress":
          setMessages((prev) => [...prev, msg.message]);
          break;
        case "complete":
          setResult(msg.result);
          break;
        case "error":
          setError(msg.message);
          break;
        case "gone":
          setGone(true);
          // If the run already finished on disk, fetch the result so the
          // LiveRun screen can transition into RunDetail. Guard against
          // the promise resolving after unmount / runId change.
          api.results.get(runId)
            .then((r) => { if (!cancelled) setResult(r); })
            .catch(() => { /* fall through */ });
          break;
      }
    };

    return () => {
      cancelled = true;
      ws.close();
      wsRef.current = null;
    };
  }, [runId]);

  return { frame, messages, result, connected, error, gone };
}
