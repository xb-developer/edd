import { useEffect, useState } from "react";
import { createApiClient } from "./api";
import type { MatterDTO } from "./types";
import { MatterDetail } from "./MatterDetail";

export interface EddWorkbenchWorkspaceProps {
  /** Defaults to the standalone app's own local server. A future host embedding this component elsewhere can point it at a different origin. */
  apiBaseUrl?: string;
  /** Auth0 React SDK's getAccessTokenSilently, supplied by the app shell. */
  getAccessToken: () => Promise<string>;
  /** Renders a "Log out" control when supplied — this component stays
   * host-agnostic (no direct Auth0 dependency), matching how getAccessToken
   * is passed in rather than imported here. */
  onLogout?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  active: "#1F2A44",
  closed: "#5B6272",
  archived: "#5B6272",
};

// Milestone 2 adds: clicking a matter shows its documents (MatterDetail),
// clicking a document shows it rendered inline (DocumentViewer). Tagging/
// filtering/export are still later milestones on top of this shell.
//
// Matches the POC's own split: the matter picker is a separate full-screen
// state with no topbar at all (mirroring MatterPicker.tsx); the persistent
// `.app` grid + `header.topbar` only appears once a matter is selected
// (mirroring Register.tsx) — this component owns that single topbar rather
// than MatterDetail duplicating one of its own.
export function EddWorkbenchWorkspace({ apiBaseUrl = "http://localhost:4430/api", getAccessToken, onLogout }: EddWorkbenchWorkspaceProps) {
  const [api] = useState(() => createApiClient(apiBaseUrl, getAccessToken));
  const [matters, setMatters] = useState<MatterDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newMatterName, setNewMatterName] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedMatterId, setSelectedMatterId] = useState<string | null>(null);

  function refresh() {
    api.getMatters().then(setMatters).catch((err) => setError(err.message));
  }

  useEffect(refresh, []);

  async function handleCreateMatter() {
    if (!newMatterName.trim()) return;
    setCreating(true);
    try {
      setError(null);
      await api.createMatter(newMatterName.trim());
      setNewMatterName("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const selectedMatter = matters?.find((m) => m.id === selectedMatterId) ?? null;

  if (selectedMatter) {
    return (
      <div className="app">
        <header className="topbar">
          <button type="button" className="topbar-btn" style={{ marginLeft: 0, background: "none" }} onClick={() => setSelectedMatterId(null)}>
            ← Back to matters
          </button>
          <div className="brand">
            <span className="mark">eD</span>
            <h1>{selectedMatter.name}</h1>
          </div>
          {onLogout && (
            <button type="button" className="topbar-btn" onClick={onLogout}>
              Log out
            </button>
          )}
        </header>
        <main className="layout">
          <MatterDetail api={api} matterId={selectedMatter.id} />
        </main>
      </div>
    );
  }

  return (
    <div className="matter-screen">
      <div className="matter-card">
        <div className="brand" style={{ marginBottom: 18 }}>
          <span className="mark" style={{ borderColor: "var(--navy)", color: "var(--navy)" }}>
            eD
          </span>
          <div>
            <h1>EDD Workbench</h1>
            <span className="sub" style={{ color: "var(--ink-soft)" }}>
              Select or create a matter
            </span>
          </div>
        </div>

        {error && <p className="bulk-note">{error}</p>}

        {!matters ? (
          <p className="empty-note">Loading…</p>
        ) : matters.length === 0 ? (
          <p className="empty-note">No matters yet.</p>
        ) : (
          <div className="matter-list">
            {matters.map((matter) => (
              <div key={matter.id} role="button" tabIndex={0} className="matter-list-item" onClick={() => setSelectedMatterId(matter.id)}>
                <span className="matter-name">{matter.name}</span>
                {matter.referenceCode && <span className="muted">{matter.referenceCode}</span>}
                <span className="chip" style={{ background: `${STATUS_COLORS[matter.status] ?? "#5B6272"}22`, color: STATUS_COLORS[matter.status] ?? "#5B6272" }}>
                  {matter.status}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="custom-tag-row" style={{ marginTop: 16 }}>
          <input placeholder="New matter name" value={newMatterName} onChange={(e) => setNewMatterName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleCreateMatter()} />
          <button type="button" onClick={handleCreateMatter} disabled={creating}>
            {creating ? "Creating…" : "Create"}
          </button>
        </div>

        {onLogout && (
          <button type="button" className="clear-filters" style={{ marginTop: 12 }} onClick={onLogout}>
            Log out
          </button>
        )}
      </div>
    </div>
  );
}
