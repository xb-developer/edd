import { useEffect, useState, type MouseEvent } from "react";
import { api } from "../api";
import type { MatterInfo } from "../types";

interface Props {
  onOpened: (matter: MatterInfo) => void;
}

export function MatterPicker({ onOpened }: Props) {
  const [matters, setMatters] = useState<MatterInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listMatters()
      .then(({ matters }) => setMatters(matters))
      .finally(() => setLoading(false));
  }, []);

  async function open(id: string) {
    setBusy(true);
    setError(null);
    try {
      const matter = await api.openMatter(id);
      onOpened(matter);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const matter = await api.createMatter(name);
      onOpened(matter);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: MatterInfo, event: MouseEvent) {
    // Stops the click reaching the row's own onClick (which opens the
    // matter) — the delete button sits inside that same clickable row.
    event.stopPropagation();
    if (!confirm(`Permanently delete "${m.name}" and every document in it? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      const { matters: remaining } = await api.deleteMatter(m.id);
      setMatters(remaining);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="matter-screen">
      <div className="matter-card">
        <div className="brand" style={{ marginBottom: 24 }}>
          <div className="mark" style={{ borderColor: "var(--navy)", color: "var(--navy)" }}>
            eD
          </div>
          <div>
            <h1 style={{ color: "var(--ink)" }}>EDD Workbench</h1>
            <div className="sub" style={{ color: "var(--ink-soft)" }}>
              Select or create a matter
            </div>
          </div>
        </div>

        {error && (
          <div className="bulk-note" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}

        {loading ? (
          <div className="empty-note">Loading matters…</div>
        ) : matters.length === 0 ? (
          <div className="empty-note">No matters yet — create one below to get started.</div>
        ) : (
          <div className="matter-list">
            {matters.map((m) => (
              // A <div>, not a <button> — it now contains a real delete
              // <button> of its own, and nesting <button> inside <button>
              // is invalid HTML (browsers silently break the inner one's
              // clicks). role="button" keeps opening-on-click discoverable
              // the same way the previous plain <button> was.
              <div
                key={m.id}
                className="matter-list-item"
                role="button"
                aria-disabled={busy}
                onClick={() => !busy && open(m.id)}
              >
                <span className="matter-name">{m.name}</span>
                <span className="muted">{new Date(m.createdAt).toLocaleDateString()}</span>
                <button
                  className="matter-delete"
                  disabled={busy}
                  title={`Delete "${m.name}"`}
                  onClick={(e) => remove(m, e)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="custom-tag-row" style={{ marginTop: 20 }}>
          <input
            placeholder="New matter name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            disabled={busy}
          />
          <button onClick={create} disabled={busy || !newName.trim()}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
