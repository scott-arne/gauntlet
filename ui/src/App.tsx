import { useState, useEffect } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation, useParams } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Sidebar } from "./components/Sidebar";
import { CardsList } from "./components/CardsList";
import { CardEditor } from "./components/CardEditor";
import { NewCardForm } from "./components/NewCardForm";
import { RunsList } from "./components/RunsList";
import { RunDetail } from "./components/RunDetail";
import { api } from "./lib/api";
import { useCards } from "./hooks/useCards";
import { useCard } from "./hooks/useCard";
import { useResults } from "./hooks/useResults";

const TABS = [
  { label: "Cards", path: "/cards" },
  { label: "Runs", path: "/runs" },
];

function CardsPage() {
  return <div className="p-6 text-slate">Select a card from the sidebar</div>;
}

function CardDetailPage({ onRefreshList }: { onRefreshList: () => void }) {
  const { id } = useParams();
  const { card, loading, error, refresh } = useCard(id);
  const navigate = useNavigate();

  if (loading) {
    return <div className="p-6 text-slate">Loading card...</div>;
  }

  if (error) {
    return <div className="p-6 text-red-700">{error}</div>;
  }

  if (!card) {
    return <div className="p-6 text-slate">Card not found</div>;
  }

  return (
    <CardEditor
      card={card}
      onSave={() => {
        refresh();
        onRefreshList();
      }}
      onDelete={() => {
        navigate("/cards");
        onRefreshList();
      }}
    />
  );
}

function NewCardPage({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  return <NewCardForm onCreated={onCreated} onCancel={onCancel} />;
}

function RunsPage() {
  return <div className="p-6 text-slate">Select a run from the sidebar</div>;
}

function RunDetailPage({ onFanout }: { onFanout: () => void }) {
  const { id } = useParams();
  const [result, setResult] = useState<import("./lib/api").VetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    api.results.get(id)
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load result"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div className="p-6 text-slate">Loading run...</div>;
  }

  if (error) {
    return <div className="p-6 text-red-700">{error}</div>;
  }

  if (!result) {
    return <div className="p-6 text-slate">Run not found</div>;
  }

  return <RunDetail result={result} onFanout={onFanout} />;
}

function CardsSidebar({
  selectedId,
  cards,
  loading,
  error,
  onRetry,
}: {
  selectedId?: string;
  cards: ReturnType<typeof useCards>["cards"];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const navigate = useNavigate();

  if (loading) {
    return <div className="p-3 text-sm text-slate">Loading cards...</div>;
  }

  if (error) {
    return (
      <div className="p-3">
        <div className="text-sm text-red-700">{error}</div>
        <button onClick={onRetry} className="mt-2 text-xs text-teal hover:underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <CardsList
      cards={cards}
      selectedId={selectedId}
      onSelect={(id) => navigate(`/cards/${id}`)}
    />
  );
}

function RunsSidebar({
  selectedId,
  results,
  loading,
  error,
  onRetry,
}: {
  selectedId?: string;
  results: ReturnType<typeof useResults>["results"];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const navigate = useNavigate();

  if (loading) {
    return <div className="p-3 text-sm text-slate">Loading runs...</div>;
  }

  if (error) {
    return (
      <div className="p-3">
        <div className="text-sm text-red-700">{error}</div>
        <button onClick={onRetry} className="mt-2 text-xs text-teal hover:underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <RunsList
      results={results}
      selectedId={selectedId}
      onSelect={(id) => navigate(`/runs/${id}`)}
    />
  );
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = location.pathname.startsWith("/runs") ? "/runs" : "/cards";
  const { cards, loading, error, refresh: refreshCards } = useCards();
  const { results, loading: runsLoading, error: runsError, refresh: refreshResults } = useResults();

  // Extract card ID from path like /cards/some-id (but not /cards/new)
  const cardIdMatch = location.pathname.match(/^\/cards\/(?!new$)(.+)/);
  const selectedCardId = cardIdMatch?.[1];

  // Extract run ID from path like /runs/some-id
  const runIdMatch = location.pathname.match(/^\/runs\/(.+)/);
  const selectedRunId = runIdMatch?.[1];

  function handleFanout() {
    refreshCards();
    refreshResults();
  }

  return (
    <AppShell
      sidebar={
        <Sidebar
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={(path) => navigate(path)}
          action={activeTab === "/cards" ? (
            <button
              className="btn-primary w-full"
              onClick={() => navigate("/cards/new")}
            >
              New Card
            </button>
          ) : (
            <button
              className="btn-primary w-full"
              disabled
              title="Coming soon"
            >
              New Run
            </button>
          )}
        >
          {activeTab === "/cards" ? (
            <CardsSidebar
              selectedId={selectedCardId}
              cards={cards}
              loading={loading}
              error={error}
              onRetry={refreshCards}
            />
          ) : (
            <RunsSidebar
              selectedId={selectedRunId}
              results={results}
              loading={runsLoading}
              error={runsError}
              onRetry={refreshResults}
            />
          )}
        </Sidebar>
      }
    >
      <Routes>
        <Route path="/" element={<Navigate to="/cards" replace />} />
        <Route path="/cards" element={<CardsPage />} />
        <Route path="/cards/new" element={
          <NewCardPage
            onCreated={(id) => { navigate(`/cards/${id}`); refreshCards(); }}
            onCancel={() => navigate("/cards")}
          />
        } />
        <Route path="/cards/:id" element={<CardDetailPage onRefreshList={refreshCards} />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunDetailPage onFanout={handleFanout} />} />
      </Routes>
    </AppShell>
  );
}
