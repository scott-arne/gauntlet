import { useState, useEffect } from "react";
import { api, type CardDetail } from "../lib/api";

interface CardEditorProps {
  card: CardDetail;
  onSave: () => void;
  onDelete: () => void;
}

export function CardEditor({ card, onSave, onDelete }: CardEditorProps) {
  const [title, setTitle] = useState(card.title);
  const [status, setStatus] = useState(card.status);
  const [tags, setTags] = useState(card.tags.join(", "));
  const [stakeholder, setStakeholder] = useState(card.stakeholder ?? "");
  const [description, setDescription] = useState(card.description);
  const [criteria, setCriteria] = useState(card.acceptanceCriteria.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(card.title);
    setStatus(card.status);
    setTags(card.tags.join(", "));
    setStakeholder(card.stakeholder ?? "");
    setDescription(card.description);
    setCriteria(card.acceptanceCriteria.join("\n"));
    setError(null);
  }, [card]);

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);
      await api.cards.update(card.id, {
        title,
        status,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        stakeholder: stakeholder || undefined,
        description,
        acceptanceCriteria: criteria.split("\n").map((c) => c.trim()).filter(Boolean),
      });
      onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove() {
    try {
      setSaving(true);
      setError(null);
      await api.cards.approve(card.id);
      onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to approve");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete card "${card.id}"? This cannot be undone.`)) return;
    try {
      setSaving(true);
      setError(null);
      await api.cards.delete(card.id);
      onDelete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="heading-display text-2xl mb-6">{card.id}</h1>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="section-label block mb-1">Title</label>
          <input
            className="input-field"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div>
          <label className="section-label block mb-1">Status</label>
          <select
            className="input-field"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="draft">draft</option>
            <option value="ready">ready</option>
            <option value="running">running</option>
            <option value="passed">passed</option>
            <option value="failed">failed</option>
          </select>
        </div>

        <div>
          <label className="section-label block mb-1">Tags</label>
          <input
            className="input-field"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="tag1, tag2, tag3"
          />
        </div>

        <div>
          <label className="section-label block mb-1">Stakeholder</label>
          <input
            className="input-field"
            value={stakeholder}
            onChange={(e) => setStakeholder(e.target.value)}
            placeholder="Optional"
          />
        </div>

        <div>
          <label className="section-label block mb-1">Description</label>
          <textarea
            className="input-field"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className="section-label block mb-1">Acceptance Criteria</label>
          <textarea
            className="input-field"
            rows={6}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder="One criterion per line"
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {status === "draft" && (
            <button
              className="btn-primary"
              onClick={handleApprove}
              disabled={saving}
            >
              Approve
            </button>
          )}
          <button
            className="btn-danger"
            onClick={handleDelete}
            disabled={saving}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
