import { useState, useEffect } from "react";
import { api, type CardSummary } from "../lib/api";

interface NewRunModalProps {
  onClose: () => void;
  onStarted: (scenarioId: string, config: { target: string; model?: string; chrome?: string }) => void;
}

export function NewRunModal({ onClose, onStarted }: NewRunModalProps) {
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [loadingCards, setLoadingCards] = useState(true);
  const [cardError, setCardError] = useState<string | null>(null);

  const [selectedCard, setSelectedCard] = useState("");
  const [target, setTarget] = useState("");
  const [model, setModel] = useState("");
  const [chrome, setChrome] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.cards.list()
      .then((list) => {
        setCards(list);
        if (list.length > 0) setSelectedCard(list[0].id);
      })
      .catch((e) => setCardError(e instanceof Error ? e.message : "Failed to load cards"))
      .finally(() => setLoadingCards(false));
  }, []);

  function handleStart() {
    setError(null);
    if (!selectedCard) {
      setError("Please select a story card");
      return;
    }
    if (!target.trim()) {
      setError("Target URL is required");
      return;
    }
    onStarted(selectedCard, {
      target: target.trim(),
      model: model.trim() || undefined,
      chrome: chrome.trim() || undefined,
    });
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-white border border-edge rounded-lg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="heading-display text-xl mb-5">New Run</h2>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="section-label block mb-1">Story Card</label>
            {loadingCards ? (
              <div className="text-sm text-slate">Loading cards...</div>
            ) : cardError ? (
              <div className="text-sm text-red-700">{cardError}</div>
            ) : cards.length === 0 ? (
              <div className="text-sm text-slate">No cards available. Create a card first.</div>
            ) : (
              <select
                className="input-field"
                value={selectedCard}
                onChange={(e) => setSelectedCard(e.target.value)}
              >
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} ({c.id})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="section-label block mb-1">Target URL</label>
            <input
              className="input-field"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="https://example.com"
            />
          </div>

          <div>
            <label className="section-label block mb-1">Model</label>
            <input
              className="input-field"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Optional — falls back to server env"
            />
          </div>

          <div>
            <label className="section-label block mb-1">Chrome Endpoint</label>
            <input
              className="input-field"
              value={chrome}
              onChange={(e) => setChrome(e.target.value)}
              placeholder="Optional — ws://localhost:9222"
            />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button className="btn-primary" onClick={handleStart}>
              Start
            </button>
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
