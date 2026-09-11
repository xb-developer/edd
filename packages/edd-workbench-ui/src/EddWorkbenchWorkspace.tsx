import { useEffect, useRef, useState } from "react";
import { Button, ConfigProvider, Input, Select } from "antd";
import { antdTheme } from "./antdTheme";
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
/**
 * Applies the shared Ant Design theme (see antdTheme.ts) to the whole
 * workspace. A wrapper rather than a provider inside the component below
 * because that component has three separate early-return render paths
 * (no matters, loading, loaded) and every one of them renders antd
 * widgets — wrapping once here is the only way they can't drift apart.
 */
export function EddWorkbenchWorkspace(props: EddWorkbenchWorkspaceProps) {
  return (
    <ConfigProvider theme={antdTheme}>
      <EddWorkbenchWorkspaceInner {...props} />
    </ConfigProvider>
  );
}

function EddWorkbenchWorkspaceInner({ apiBaseUrl = "http://localhost:4430/api", getAccessToken, onLogout }: EddWorkbenchWorkspaceProps) {
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
    if (!selectedMatter) return;
    setDownloadingAudit(true);
    try {
      setError(null);
      const blob = await api.downloadAuditLog(selectedMatter.id);
      // Blob -> temporary object URL -> synthetic <a download> click is the
      // standard way to save a fetched (not navigated-to) file — the
      // Authorization header this needs can't be attached to a plain
      // <a href> navigation, so a real anchor click has to happen here,
      // inside this same user-gesture-triggered handler.
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `audit-log-${selectedMatter.id}-${new Date().toISOString().slice(0, 10)}.csv`;
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
      <div className="flex h-full flex-col">
        <header className="relative flex flex-[0_0_auto] items-center gap-5 border-b-[3px] border-seal bg-navy px-5 py-3 text-white">
          <div className="flex items-baseline gap-2">
            <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[3px] border-[1.5px] border-white font-mono text-[11px] font-semibold">Co</span>
          </div>
          <Button ghost size="small" className="ml-auto" onClick={() => setShowNotices(true)}>
            Notices
          </Button>
          {onLogout && (
            <Button ghost size="small" className="ml-auto" onClick={handleLogout}>
              Log out
            </Button>
          )}
        </header>
        <p className="px-0.5 py-1 text-[11.5px] italic text-ink-soft" style={{ padding: 24 }}>
          You don't have access to any matters yet. Ask an admin to add you to one.
        </p>
        {error && <p className="mt-1.5 text-[11.5px] text-seal">{error}</p>}
        {showNotices && <NoticeDialog onClose={() => setShowNotices(false)} />}
      </div>
    );
  }

  const selectedMatter = matters?.find((m) => m.id === selectedMatterId) ?? null;
  const canManageAccess = !!me && !!selectedMatter && (me.role === "admin" || me.userId === selectedMatter.createdBy);

  if (!matters || !selectedMatter) {
    return (
      <div className="flex h-full flex-col">
        <header className="relative flex flex-[0_0_auto] items-center gap-5 border-b-[3px] border-seal bg-navy px-5 py-3 text-white">
          <div className="flex items-baseline gap-2">
            <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[3px] border-[1.5px] border-white font-mono text-[11px] font-semibold">Co</span>
          </div>
          <Button ghost size="small" className="ml-auto" onClick={() => setShowNotices(true)}>
            Notices
          </Button>
          {onLogout && (
            <Button ghost size="small" className="ml-auto" onClick={handleLogout}>
              Log out
            </Button>
          )}
        </header>
        <p className="px-0.5 py-1 text-[11.5px] italic text-ink-soft">Loading…</p>
        {error && <p className="mt-1.5 text-[11.5px] text-seal">{error}</p>}
        {showNotices && <NoticeDialog onClose={() => setShowNotices(false)} />}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="relative flex flex-[0_0_auto] items-center gap-5 border-b-[3px] border-seal bg-navy px-5 py-3 text-white">
        {/* showSearch: a real org accumulates enough matters that scanning
            a plain dropdown stops being viable, and this is the only place
            to switch between them. */}
        <Select
          showSearch
          size="small"
          className="max-w-[220px] [&_.ant-select-selector]:!border-white/50 [&_.ant-select-selector]:!bg-transparent [&_.ant-select-selection-item]:!font-semibold [&_.ant-select-selection-item]:!text-white [&_.ant-select-arrow]:!text-white"
          popupMatchSelectWidth={false}
          optionFilterProp="label"
          value={selectedMatter.id}
          onChange={selectMatter}
          aria-label="Select matter"
          options={matters.map((matter) => ({ value: matter.id, label: matter.name }))}
        />
        <div className="flex items-baseline gap-2">
          {editingName ? (
            <Input
              variant="borderless"
              className="text-[15px] font-semibold"
              size="small"
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
            <h1
              className="m-0 -mx-1.5 -my-0.5 cursor-pointer rounded-[3px] px-1.5 py-0.5 text-[15px] font-semibold tracking-[0.2px] hover:bg-white/10"
              role="button"
              tabIndex={0}
              onClick={() => startEditingName(selectedMatter.name)}
            >
              {selectedMatter.name}
            </h1>
          )}
        </div>
        {canCreateMatters && (
          <Button ghost size="small" className="ml-0" onClick={handleCreateMatter} loading={creating}>
            Create Matter
          </Button>
        )}
        {canDownloadAuditLog && (
          <Button ghost size="small" className="ml-0" onClick={handleDownloadAuditLog} loading={downloadingAudit}>
            Download Audit Log
          </Button>
        )}
        {canDeleteMatter && (
          <Button ghost size="small" className="ml-0" onClick={handleDeleteMatter} loading={deletingMatter}>
            Delete Matter
          </Button>
        )}
        <WorkerHealthBar api={api} matterId={selectedMatter.id} />
        <Button ghost size="small" className="ml-auto" onClick={() => setShowNotices(true)}>
          Notices
        </Button>
        {onLogout && (
          <Button ghost size="small" className="ml-auto" onClick={handleLogout}>
            Log out
          </Button>
        )}
      </header>
      {error && <p className="mt-1.5 text-[11.5px] text-seal">{error}</p>}
      {showNotices && <NoticeDialog onClose={() => setShowNotices(false)} />}
      <main className="flex min-h-0 flex-1">
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
