import { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  parseJsonl,
  reduceTranscript,
  type TranscriptModel,
} from "../lib/transcript";

/**
 * Pure helper: parse a raw JSONL string into a TranscriptModel.
 * Used by the static-mode branch so this path can be unit-tested
 * without a DOM or hook runner.
 */
export function parseTranscriptFromStaticPayload(runJsonl: string): TranscriptModel {
  const events = parseJsonl(runJsonl);
  return reduceTranscript(events);
}

export type TranscriptError = "not-found" | "network" | "parse";

export interface UseTranscriptResult {
  model: TranscriptModel | null;
  loading: boolean;
  /** `"not-found"` means this run has no run.jsonl on disk (legacy or empty). */
  error: TranscriptError | null;
}

export function useTranscript(runId: string | null): UseTranscriptResult {
  const [model, setModel] = useState<TranscriptModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<TranscriptError | null>(null);

  useEffect(() => {
    if (!runId) {
      setModel(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setModel(null);

    const staticPayload = typeof window !== "undefined" ? window.__GAUNTLET_RUN__ : undefined;
    if (staticPayload?.runJsonl) {
      try {
        const events = parseJsonl(staticPayload.runJsonl);
        if (!cancelled) setModel(reduceTranscript(events));
      } catch {
        if (!cancelled) setError("parse");
      }
      if (!cancelled) setLoading(false);
      return;
    }

    api.results.fileText(runId, "run.jsonl")
      .then((text) => {
        if (cancelled) return;
        try {
          const events = parseJsonl(text);
          setModel(reduceTranscript(events));
        } catch {
          setError("parse");
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof Error && e.message === "not-found") {
          setError("not-found");
        } else {
          setError("network");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [runId]);

  return { model, loading, error };
}
