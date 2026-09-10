import { useEffect, useRef, useState } from "react";
import { createApiClient } from "./api";
import type { MatterDTO } from "./types";
import { MatterDetail } from "./MatterDetail";
import { closeViewerWindowForMatter } from "./viewer-window/useViewerWindow";
import { WorkerHealthBar } from "./WorkerHealthBar";
import { NoticeDialog } from "./NoticeDialog";

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

// Persists across refreshes so re-opening the app returns to the same
// matter rather than always defaulting to the most recent one.
const SELECTED_MATTER_STORAGE_KEY = "edd-workbench:selectedMatterId";

// There's no separate "pick a matter" screen anymore — the app always shows
// the single topbar + tree-panel layout. Matter switching lives in a
// top-left <select>; a brand-new org with zero matters skips straight to a
// freshly created one instead of showing an empty state.
export function EddWorkbenchWorkspace({ apiBaseUrl = "http://localhost:4430/api", getAccessToken, onLogout }: EddWorkbenchWorkspaceProps) {
  const [api] = useState(() => createApiClient(apiBaseUrl, getAccessToken));
  const [matters, setMatters] = useState<MatterDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedMatterId, setSelectedMatterId] = useState<string | null>(null);
  // The caller's own local identity — needed to decide whether the current
  // user may manage a matter's access list (admin, or that matter's own
  // creator). Fetched once; doesn't change per matter.
  const [me, setMe] = useState<{ userId: string; role: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingMatter, setDeletingMatter] = useState(false);
  const [downloadingAudit, setDownloadingAudit] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [showNotices, setShowNotices] = useState(false);
  // Guards against a commit firing twice (e.g. Enter's own blur plus a
  // real blur landing close together) and against Escape's cancellation
  // being immediately followed by a stray blur-on-unmount commit.
  const committingRef = useRef(false);
  const cancelledRef = useRef(false);
  const bootstrapped = useRef(false);

  function selectMatter(matterId: string) {
    setSelectedMatterId(matterId);
    localStorage.setItem(SELECTED_MATTER_STORAGE_KEY, matterId);
    // Fire-and-forget — every time a matter becomes the active one (initial
    // auto-select AND every dropdown switch), not just once per session.
    api.recordMatterLoad(matterId).catch(() => {});
  }

  function startEditingName(currentName: string) {
    setNameInput(currentName);
    setEditingName(true);
  }

  useEffect(() => {
    // StrictMode double-invokes effects in dev; without this guard a
    // brand-new org could end up with two "New matter" rows created.
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    // getMe and getMatters are fetched together, not independently — the
    // empty-matters branch below needs to know the caller's role BEFORE
    // deciding whether to auto-create is even a valid path (only
    // admin/litigation_support can create a matter; a reviewer with zero
    // *accessible* matters — a real possibility now that GET /matters is
    // filtered by matter_members for non-admins — would otherwise attempt
    // createMatter and get a 403 there's no visible recovery from).
    Promise.all([api.getMe(), api.getMatters()])
      .then(async ([meResult, fetched]) => {
        setMe(meResult);
        const canCreate = meResult.role === "admin" || meResult.role === "litigation_support";

        if (fetched.length === 0) {
          if (!canCreate) {
            // Not "no matters exist anywhere" necessarily — just none this
            // user has been granted access to yet, and they have no way to
            // create one themselves. Show that plainly instead of trying
            // (and silently failing) to auto-create.
            setMatters([]);
            return;
          }
          const created = await api.createMatter("New matter");
          setMatters([created]);
          selectMatter(created.id);
          startEditingName(created.name);
          return;
        }

        setMatters(fetched);
        const storedId = localStorage.getItem(SELECTED_MATTER_STORAGE_KEY);
        const stillExists = storedId && fetched.some((m) => m.id === storedId);
        selectMatter(stillExists ? storedId! : fetched[0].id);
      })
      .catch((err) => setError(err.message));
    // Deliberately run once — guarded by bootstrapped, not by dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whoever successfully calls this is always an admin (server-side
  // requireRole("admin") on the DELETE route — see matters.ts) — so a
  // zero-matters aftermath always gets the same "skip straight to a fresh
  // one" treatment as a brand-new org's bootstrap above, rather than
  // falling into the `matters?.length === 0` "ask an admin to add you"
  // screen below, which would be nonsensical for the admin who just did
  // the deleting.
  async function handleDeleteMatter() {
    if (!selectedMatter) return;
    if (!window.confirm(`Delete matter "${selectedMatter.name}"? Every document, tag, and export in it will be deleted too. This cannot be undone.`)) return;
    setDeletingMatter(true);
    try {
      setError(null);
      await api.deleteMatter(selectedMatter.id);
      closeViewerWindowForMatter(selectedMatter.id);
      const remaining = (matters ?? []).filter((m) => m.id !== selectedMatter.id);
      if (remaining.length > 0) {
        setMatters(remaining);
        selectMatter(remaining[0].id);
      } else {
        const created = await api.createMatter("New matter");
        setMatters([created]);
        selectMatter(created.id);
        startEditingName(created.name);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingMatter(false);
    }
  }

  async function handleDownloadAuditLog() {
    setDownloadingAudit(true);
    try {
      setError(null);
      const blob = await api.downloadAuditLog();
      // Blob -> temporary object URL -> synthetic <a download> click is the
      // standard way to save a fetched (not navigated-to) file — the
      // Authorization header this needs can't be attached to a plain
      // <a href> navigation, so a real anchor click has to happen here,
      // inside this same user-gesture-triggered handler.
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDownloadingAudit(false);
    }
  }

  async function handleCreateMatter() {
    setCreating(true);
    try {
      setError(null);
      const created = await api.createMatter("New matter");
      setMatters((prev) => [created, ...(prev ?? [])]);
      selectMatter(created.id);
      startEditingName(created.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function commitName() {
    if (committingRef.current) return;
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    committingRef.current = true;
    try {
      const trimmed = nameInput.trim();
      if (!selectedMatterId || !trimmed) {
        // Never send an empty rename — treat it the same as Escape.
        setEditingName(false);
        return;
      }
      setError(null);
      const updated = await api.updateMatter(selectedMatterId, trimmed);
      setMatters((prev) => prev?.map((m) => (m.id === updated.id ? updated : m)) ?? prev);
      setEditingName(false);
    } catch (err) {
      // Stay in edit mode with the attempted value so the user can retry
      // rather than silently losing what they typed.
      setError((err as Error).message);
    } finally {
      committingRef.current = false;
    }
  }

  function cancelEditingName() {
    cancelledRef.current = true;
    setEditingName(false);
  }

  async function handleLogout() {
    // Best-effort — a failure here must never block the user from actually
    // logging out.
    await api.recordLogout().catch(() => {});
    if (selectedMatterId) closeViewerWindowForMatter(selectedMatterId);
    localStorage.removeItem(SELECTED_MATTER_STORAGE_KEY);
    onLogout?.();
  }

  const canCreateMatters = me?.role === "admin" || me?.role === "litigation_support";
  // Narrower than canCreateMatters — admin only, matching the server's own
  // requireRole("admin") on the DELETE route (deleting a matter is a much
  // bigger blast radius than creating or renaming one).
  const canDeleteMatter = me?.role === "admin";
  // Same admin-only gate as canDeleteMatter, named separately since it's a
  // different action — matches the server's own requireRole("admin") on
  // GET /audit/export (audit_log reveals every user's activity org-wide).
  const canDownloadAuditLog = me?.role === "admin";

  // Distinct from the plain "still loading" case below — this is a known,
  // final state (the fetch succeeded; there's just nothing this user can
  // see), not a transient one, so it must never be confused with "Loading…"
  // by checking matters === null rather than its length.
  if (matters?.length === 0) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="mark">Co</span>
          </div>
          <button type="button" className="topbar-btn" onClick={() => setShowNotices(true)}>
            Notices
          </button>
          {onLogout && (
            <button type="button" className="topbar-btn" onClick={handleLogout}>
              Log out
            </button>
          )}
        </header>
        <p className="empty-note" style={{ padding: 24 }}>
          You don't have access to any matters yet. Ask an admin to add you to one.
        </p>
        {error && <p className="bulk-note">{error}</p>}
        {showNotices && <NoticeDialog onClose={() => setShowNotices(false)} />}
      </div>
    );
  }

  const selectedMatter = matters?.find((m) => m.id === selectedMatterId) ?? null;
  const canManageAccess = !!me && !!selectedMatter && (me.role === "admin" || me.userId === selectedMatter.createdBy);

  if (!matters || !selectedMatter) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="mark">Co</span>
          </div>
          <button type="button" className="topbar-btn" onClick={() => setShowNotices(true)}>
            Notices
          </button>
          {onLogout && (
            <button type="button" className="topbar-btn" onClick={handleLogout}>
              Log out
            </button>
          )}
        </header>
        <p className="empty-note">Loading…</p>
        {error && <p className="bulk-note">{error}</p>}
        {showNotices && <NoticeDialog onClose={() => setShowNotices(false)} />}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <select className="matter-select" value={selectedMatter.id} onChange={(e) => selectMatter(e.target.value)} aria-label="Select matter">
          {matters.map((matter) => (
            <option key={matter.id} value={matter.id}>
              {matter.name}
            </option>
          ))}
        </select>
        <div className="brand">
          {editingName ? (
            <input
              className="matter-name-input"
              autoFocus
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  cancelEditingName();
                }
              }}
              onBlur={commitName}
            />
          ) : (
            <h1 className="matter-name-display" role="button" tabIndex={0} onClick={() => startEditingName(selectedMatter.name)}>
              {selectedMatter.name}
            </h1>
          )}
        </div>
        {canCreateMatters && (
          <button type="button" className="topbar-btn" style={{ marginLeft: 0 }} onClick={handleCreateMatter} disabled={creating}>
            {creating ? "Creating…" : "Create Matter"}
          </button>
        )}
        {canDownloadAuditLog && (
          <button type="button" className="topbar-btn" style={{ marginLeft: 0 }} onClick={handleDownloadAuditLog} disabled={downloadingAudit}>
            {downloadingAudit ? "Downloading…" : "Download Audit Log"}
          </button>
        )}
        {canDeleteMatter && (
          <button type="button" className="topbar-btn" style={{ marginLeft: 0 }} onClick={handleDeleteMatter} disabled={deletingMatter}>
            {deletingMatter ? "Deleting…" : "Delete Matter"}
          </button>
        )}
        <WorkerHealthBar api={api} matterId={selectedMatter.id} />
        <button type="button" className="topbar-btn" onClick={() => setShowNotices(true)}>
          Notices
        </button>
        {onLogout && (
          <button type="button" className="topbar-btn" onClick={handleLogout}>
            Log out
          </button>
        )}
      </header>
      {error && <p className="bulk-note">{error}</p>}
      {showNotices && <NoticeDialog onClose={() => setShowNotices(false)} />}
      <main className="layout">
        <MatterDetail
          api={api}
          matterId={selectedMatter.id}
          canManageAccess={canManageAccess}
          currentUserId={me?.userId ?? ""}
          matterCreatedBy={selectedMatter.createdBy}
        />
      </main>
    </div>
  );
}
