import { useState, useMemo } from "react";
import type { CardSummary } from "../lib/api";

interface CardsListProps {
  cards: CardSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

function StatusBadge({ status }: { status: string }) {
  const isReady = status === "ready";
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
        isReady
          ? "bg-teal-wash text-teal-dark"
          : "bg-panel text-slate"
      }`}
    >
      {status}
    </span>
  );
}

export function CardsList({ cards, selectedId, onSelect }: CardsListProps) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const card of cards) {
      for (const tag of card.tags) {
        tags.add(tag);
      }
    }
    return Array.from(tags).sort();
  }, [cards]);

  const filtered = useMemo(() => {
    return cards.filter((card) => {
      if (statusFilter !== "all" && card.status !== statusFilter) return false;
      if (tagFilter !== "all" && !card.tags.includes(tagFilter)) return false;
      return true;
    });
  }, [cards, statusFilter, tagFilter]);

  return (
    <div className="flex flex-col">
      <div className="flex gap-2 border-b border-edge p-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="input-field !w-auto !py-1 !text-xs"
        >
          <option value="all">All status</option>
          <option value="draft">Draft</option>
          <option value="ready">Ready</option>
        </select>
        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          className="input-field !w-auto !py-1 !text-xs"
        >
          <option value="all">All tags</option>
          {allTags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-3 text-sm text-slate">No cards match filters</div>
        ) : (
          filtered.map((card) => (
            <button
              key={card.id}
              onClick={() => onSelect(card.id)}
              className={`w-full text-left px-3 py-2.5 border-b border-edge-light transition-colors duration-150 ${
                selectedId === card.id
                  ? "bg-teal-wash"
                  : "hover:bg-panel"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium text-ink leading-snug">
                  {card.title}
                </span>
                <StatusBadge status={card.status} />
              </div>
              <div className="mt-0.5 text-xs text-slate">{card.id}</div>
              {card.tags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {card.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs text-slate"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
