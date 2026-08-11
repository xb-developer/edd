import { useEffect, useState } from "react";
import { useBoundApi } from "../useCloudApi";
import type { Matter } from "../types";

interface Group {
  id: string;
  name: string;
}

interface Props {
  onOpen: (matter: Matter) => void;
}

export function MatterList({ onOpen }: Props) {
  const api = useBoundApi();
  const [matters, setMatters] = useState<Matter[] | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [newName, setNewName] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.listMatters().then(setMatters).catch((e) => setError(String(e)));
    api.listGroups().then((rows) => {
      setGroups(rows);
      if (rows.length > 0) setSelectedGroupId(rows[0].id);
    }).catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !selectedGroupId) return;
    setCreating(true);
    setError(null);
    try {
      const matter = await api.createMatter(newName.trim(), selectedGroupId);
      setMatters((prev) => [matter, ...(prev ?? [])]);
      setNewName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="matter-list-screen">
      <h1>Matters</h1>
      {error && <p className="error-text">{error}</p>}

      {matters === null ? (
        <p>Loading matters…</p>
      ) : matters.length === 0 ? (
        <p className="muted">No matters yet — create one below to get started.</p>
      ) : (
        <ul className="matter-list">
          {matters.map((m) => (
            <li key={m.id}>
              <button className="matter-row" onClick={() => onOpen(m)}>
                <span className="matter-name">{m.name}</span>
                <span className="muted">created {new Date(m.created_at).toLocaleDateString()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="create-matter-form" onSubmit={handleCreate}>
        <h2>Create a matter</h2>
        {groups !== null && groups.length === 0 ? (
          <p className="muted">
            You're not a member of any group yet — ask your firm administrator to add you to one before you can
            create a matter.
          </p>
        ) : (
          <>
            <input
              type="text"
              placeholder="Matter name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
            />
            <select value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)}>
              {groups?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <button type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create matter"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
