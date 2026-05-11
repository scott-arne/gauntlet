import { useState, useEffect } from "react";
import { api, type CardSummary } from "../lib/api";
import { Spinner } from "./shared";

export interface NewRunPrefill {
  cardId?: string;
  target?: string;
  model?: string;
  chrome?: string;
  adapter?: "web" | "cli" | "tui";
  viewport?: { width: number; height: number };
  saveScreencast?: boolean;
  passes?: number;
}

interface NewRunModalProps {
  onClose: () => void;
  onStarted: (
    cardId: string,
    config: {
      target: string;
      model?: string;
      chrome?: string;
      adapter?: string;
      viewport?: { width: number; height: number };
      saveScreencast?: boolean;
      passes?: number;
    },
  ) => void;
  prefill?: NewRunPrefill;
}

export function NewRunModal({ onClose, onStarted, prefill }: NewRunModalProps) {
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [loadingCards, setLoadingCards] = useState(true);
  const [cardError, setCardError] = useState<string | null>(null);

  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedCard, setSelectedCard] = useState(prefill?.cardId ?? "");
  const [target, setTarget] = useState(prefill?.target ?? "");
  const [model, setModel] = useState(prefill?.model ?? "");
  const [chrome, setChrome] = useState(prefill?.chrome ?? "");
  const [passes, setPasses] = useState<string>(
    prefill?.passes !== undefined ? String(prefill.passes) : "",
  );
  // Screencast disk persistence. Prefill from caller ("Run again") > server
  // default (hydrated from /api/config below). Passed through to the body
  // as-is so POST /api/run/:id overrides the server default per-run.
  const [saveScreencast, setSaveScreencast] = useState<boolean>(
    prefill?.saveScreencast ?? false,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.cards.list()
      .then((list) => {
        setCards(list);
        if (list.length > 0 && !selectedCard) setSelectedCard(list[0].id);
      })
      .catch((e) => setCardError(e instanceof Error ? e.message : "Failed to load cards"))
      .finally(() => setLoadingCards(false));

    api.config.get()
      .then((config) => {
        setAvailableModels(config.models);
        // Prefill from user intent > server defaults. Never clobber a
        // value the user (or a "Run again" caller) explicitly supplied.
        if (!prefill?.model && config.defaultModel) setModel(config.defaultModel);
        if (!prefill?.target && config.defaultTarget) setTarget(config.defaultTarget);
        if (prefill?.saveScreencast === undefined) setSaveScreencast(config.defaultSaveScreencast);
      })
      .catch(() => { /* config fetch is best-effort */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    let passesNum: number | undefined;
    if (passes.trim() !== "") {
      const parsed = Number.parseInt(passes, 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 50) {
        setError("Passes must be an integer in [1, 50]");
        return;
      }
      passesNum = parsed;
    }
    onStarted(selectedCard, {
      target: target.trim(),
      model: model.trim() || undefined,
      chrome: chrome.trim() || undefined,
      adapter: prefill?.adapter,
      // Viewport is not yet a user-visible field — we pass through the
      // prefill (from "Run Again") so a re-run lands at the same
      // dimensions as the original. New runs from the button get the
      // server default via AppConfig.
      viewport: prefill?.viewport,
      saveScreencast,
      passes: passesNum,
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
              <Spinner label="Loading cards..." />
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
            {availableModels.length > 0 ? (
              <select
                className="input-field"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                className="input-field"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. claude-sonnet-4-6"
              />
            )}
            {!model && availableModels.length === 0 && (
              <p className="text-xs text-red-600 mt-1">
                No model configured. Set GAUNTLET_MODELS or GAUNTLET_AGENT_MODEL on the server.
              </p>
            )}
          </div>

          <div>
            <label className="section-label block mb-1">Passes</label>
            <input
              className="input-field"
              type="number"
              min={1}
              max={50}
              value={passes}
              onChange={(e) => setPasses(e.target.value)}
              placeholder="1"
            />
            <p className="text-xs text-slate mt-1">
              Number of passes to run. Leave blank for a single run.
            </p>
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

          <div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={saveScreencast}
                onChange={(e) => setSaveScreencast(e.target.checked)}
              />
              <span>Save screencast to disk</span>
            </label>
            <p className="text-xs text-slate mt-1 ml-6">
              Off by default. Live view keeps working either way; this only
              controls whether frames are written to the run directory
              (100MB–1GB per run).
            </p>
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
