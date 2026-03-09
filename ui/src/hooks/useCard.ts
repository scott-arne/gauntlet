import { useState, useEffect, useCallback } from "react";
import { api, type CardDetail } from "../lib/api";

export function useCard(id: string | undefined) {
  const [card, setCard] = useState<CardDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) {
      setCard(null);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const data = await api.cards.get(id);
      setCard(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load card");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { card, loading, error, refresh, setCard };
}
