import { useState, useEffect, useCallback } from "react";
import { api, type VetResult } from "../lib/api";

export function useResults() {
  const [results, setResults] = useState<VetResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.results.list();
      setResults(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load results");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { results, loading, error, refresh };
}
