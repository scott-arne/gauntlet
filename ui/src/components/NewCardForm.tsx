import { useState } from "react";
import { api } from "../lib/api";

interface NewCardFormProps {
  onCreated: (id: string) => void;
  onCancel: () => void;
}

export function NewCardForm({ onCreated, onCancel }: NewCardFormProps) {
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  async function handleSubmit() {
    setAttempted(true);
    if (!id.trim() || !title.trim()) {
      setError("ID and Title are required");
      return;
    }

    try {
      setSaving(true);
      setError(null);
      await api.cards.create({
        id: id.trim(),
        title: title.trim(),
        status: "draft",
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        description: description,
        acceptanceCriteria: criteria.split("\n").map((c) => c.trim()).filter(Boolean),
      });
      onCreated(id.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create card");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="heading-display text-2xl mb-6">New Card</h1>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="section-label block mb-1">ID</label>
          <input
            className={`input-field ${attempted && !id.trim() ? "!border-red-400" : ""}`}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="unique-card-id"
          />
        </div>

        <div>
          <label className="section-label block mb-1">Title</label>
          <input
            className={`input-field ${attempted && !title.trim() ? "!border-red-400" : ""}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
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
            onClick={handleSubmit}
            disabled={saving}
          >
            {saving ? "Creating..." : "Create"}
          </button>
          <button
            className="btn-secondary"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
