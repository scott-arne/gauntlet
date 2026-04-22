import { useState, useEffect, useCallback } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation, useParams } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Sidebar } from "./components/Sidebar";
import { CardsList } from "./components/CardsList";
import { CardEditor } from "./components/CardEditor";
import { NewCardForm } from "./components/NewCardForm";
import { RunsList } from "./components/RunsList";
import { RunDetail } from "./components/RunDetail";
import { NewRunModal, type NewRunPrefill } from "./components/NewRunModal";
import { LiveRun } from "./components/LiveRun";
import { TranscriptView } from "./components/transcript";
import { Spinner } from "./components/shared";
import { api, type VetResult, type ActiveRun } from "./lib/api";
import { useCards } from "./hooks/useCards";
import { useCard } from "./hooks/useCard";
import { useResults } from "./hooks/useResults";
import { useActiveRuns } from "./hooks/useActiveRuns";

const TABS = [
  { label: "Cards", path: "/cards" },
  { label: "Runs", path: "/runs" },
];

function CardsPage() {
  return (
    <div className="p-6 text-slate">
      <p>Select a card from the sidebar, or create a new one.</p>
    </div>
  );
}

function CardDetailPage({ onRefreshList }: { onRefreshList: () => void }) {
  const { id } = useParams();
  const { card, loading, error, refresh } = useCard(id);
  const navigate = useNavigate();

  if (loading) {
    return <div className="p-6"><Spinner label="Loading card..." /></div>;
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
  return (
    <div className="p-6 text-slate">
      <p>Select a run from the sidebar, or start a new one.</p>
    </div>
  );
}

function RunDetailPage({ onFanout, onRunAgain }: { onFanout: () => void; onRunAgain: (prefill: NewRunPrefill) => void }) {
  // Route path uses :id for historical reasons; the value is a runId
  // (`<cardId>_<YYYYMMDDTHHMMSSZ>_<nonce>`), which is the directory name
  // under .gauntlet/results/ and the primary key backend-side.
  const { id: runId } = useParams();
  const [result, setResult] = useState<VetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    api.results.get(runId)
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load result"))
      .finally(() => setLoading(false));
  }, [runId]);

  if (loading) {
    return <div className="p-6"><Spinner label="Loading run..." /></div>;
  }

  if (error) {
    return <div className="p-6 text-red-700">{error}</div>;
  }

  if (!result) {
    return <div className="p-6 text-slate">Run not found</div>;
  }

  return <RunDetail result={result} onFanout={onFanout} onRunAgain={onRunAgain} />;
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
    return <div className="p-3"><Spinner label="Loading cards..." /></div>;
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
  activeRuns,
  loading,
  error,
  onRetry,
  onSelectActive,
  hasMore,
  onLoadMore,
}: {
  selectedId?: string;
  results: ReturnType<typeof useResults>["results"];
  activeRuns: ActiveRun[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelectActive: (runId: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const navigate = useNavigate();

  if (loading && activeRuns.length === 0 && results.length === 0) {
    return <div className="p-3"><Spinner label="Loading runs..." /></div>;
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
      activeRuns={activeRuns}
      selectedId={selectedId}
      onSelect={(runId) => navigate(`/runs/${runId}`)}
      onSelectActive={onSelectActive}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
    />
  );
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = location.pathname.startsWith("/runs") ? "/runs" : "/cards";
  const { cards, loading, error, refresh: refreshCards } = useCards();
  const {
    results,
    loading: runsLoading,
    error: runsError,
    refresh: refreshResults,
    loadMore: loadMoreResults,
    hasMore: hasMoreResults,
  } = useResults();
  const { runs: activeRuns, loaded: activeRunsLoaded, refresh: refreshActive } = useActiveRuns();
  const [runModal, setRunModal] = useState<{ prefill?: NewRunPrefill } | null>(null);

  const cardIdMatch = location.pathname.match(/^\/cards\/(?!new$)(.+)/);
  const selectedCardId = cardIdMatch?.[1];

  // /runs/:id (but not /runs/live/* and not /runs/:id/transcript sidebar selection)
  const runIdMatch = location.pathname.match(/^\/runs\/(?!live(?:\/|$))([^/]+)/);
  const selectedRunId = runIdMatch?.[1];

  // /runs/live/:id (including /runs/live/:id/transcript)
  const liveIdMatch = location.pathname.match(/^\/runs\/live\/([^/]+)/);
  const liveRunId = liveIdMatch?.[1];

  // Top of the active-runs list = the freshest in-flight run (registry sorts desc).
  const topActiveRun = activeRuns[0] ?? null;

  function handleFanout() {
    refreshCards();
    refreshResults();
  }

  const handleRunComplete = useCallback((runId: string) => {
    refreshActive();
    refreshResults();
    navigate(`/runs/${runId}`);
  }, [refreshActive, refreshResults, navigate]);

  return (
    <>
      <AppShell
        sidebar={
          <Sidebar
            tabs={TABS}
            activeTab={activeTab}
            onTabChange={(path) => navigate(path)}
            liveRun={topActiveRun ? {
              title: topActiveRun.title,
              onClick: () => navigate(`/runs/live/${topActiveRun.id}`),
            } : null}
            action={activeTab === "/cards" ? (
              <button className="btn-primary w-full" onClick={() => navigate("/cards/new")}>
                New Card
              </button>
            ) : (
              <button className="btn-primary w-full" onClick={() => setRunModal({})}>
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
                selectedId={selectedRunId ?? liveRunId}
                results={results}
                activeRuns={activeRuns}
                loading={runsLoading}
                error={runsError}
                onRetry={refreshResults}
                onSelectActive={(runId) => navigate(`/runs/live/${runId}`)}
                hasMore={hasMoreResults}
                onLoadMore={loadMoreResults}
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
          <Route path="/runs/live" element={
            topActiveRun
              ? <Navigate to={`/runs/live/${topActiveRun.id}`} replace />
              : <Navigate to="/runs" replace />
          } />
          <Route path="/runs/live/:id" element={
            <LiveRun
              activeRuns={activeRuns}
              activeRunsLoaded={activeRunsLoaded}
              onComplete={handleRunComplete}
            />
          } />
          <Route path="/runs/:id" element={
            <RunDetailPage
              onFanout={handleFanout}
              onRunAgain={(prefill) => setRunModal({ prefill })}
            />
          } />
          <Route path="/runs/:id/transcript" element={<TranscriptView mode="posthoc" />} />
          <Route path="/runs/live/:id/transcript" element={<TranscriptView mode="live" />} />
        </Routes>
      </AppShell>

      {runModal && (
        <NewRunModal
          prefill={runModal.prefill}
          onClose={() => setRunModal(null)}
          onStarted={async (cardId, config) => {
            setRunModal(null);
            try {
              const { runId } = await api.run.start(cardId, config);
              await refreshActive();
              navigate(`/runs/live/${runId}`);
            } catch (e) {
              // Start failed synchronously — surface error via refresh so
              // any server-side error gets logged, then bounce to Runs tab.
              refreshResults();
              navigate("/runs");
              // TODO: a toast would be nicer than an alert, but not in scope
              // for this task.
              alert(e instanceof Error ? e.message : "Run failed to start");
            }
          }}
        />
      )}
    </>
  );
}
