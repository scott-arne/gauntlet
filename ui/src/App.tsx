import { Routes, Route, Navigate, useNavigate, useLocation, useParams } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Sidebar } from "./components/Sidebar";
import { CardsList } from "./components/CardsList";
import { useCards } from "./hooks/useCards";

const TABS = [
  { label: "Cards", path: "/cards" },
  { label: "Runs", path: "/runs" },
];

function CardsPage() {
  return <div className="p-6 text-slate">Select a card from the sidebar</div>;
}

function CardDetailPage() {
  const { id } = useParams();
  return <div className="p-6 text-slate">Card: {id}</div>;
}

function RunsPage() {
  return <div className="p-6 text-slate">Select a run from the sidebar</div>;
}

function CardsSidebar({ selectedId }: { selectedId?: string }) {
  const { cards, loading, error, refresh } = useCards();
  const navigate = useNavigate();

  if (loading) {
    return <div className="p-3 text-sm text-slate">Loading cards...</div>;
  }

  if (error) {
    return (
      <div className="p-3">
        <div className="text-sm text-red-700">{error}</div>
        <button onClick={refresh} className="mt-2 text-xs text-teal hover:underline">
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

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = location.pathname.startsWith("/runs") ? "/runs" : "/cards";

  // Extract card ID from path like /cards/some-id
  const cardIdMatch = location.pathname.match(/^\/cards\/(.+)/);
  const selectedCardId = cardIdMatch?.[1];

  return (
    <AppShell
      sidebar={
        <Sidebar
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={(path) => navigate(path)}
        >
          {activeTab === "/cards" ? (
            <CardsSidebar selectedId={selectedCardId} />
          ) : (
            <div className="p-3 text-sm text-slate">Loading runs...</div>
          )}
        </Sidebar>
      }
    >
      <Routes>
        <Route path="/" element={<Navigate to="/cards" replace />} />
        <Route path="/cards" element={<CardsPage />} />
        <Route path="/cards/:id" element={<CardDetailPage />} />
        <Route path="/runs/*" element={<RunsPage />} />
      </Routes>
    </AppShell>
  );
}
