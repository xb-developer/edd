import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { DocumentDTO, FilterMode, Tag } from "./types";
import { ResultsTable, type SortKey } from "./components/ResultsTable";
import { FilterPanel } from "./components/FilterPanel";
import { CodingPanel, tagColorFor } from "./components/CodingPanel";
import { PreviewPane } from "./components/PreviewPane";
import { AskPanel } from "./components/AskPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { formatSize } from "./lib/format";

interface Props {
  matterName: string;
  onSwitchMatter: () => void;
}

// Preview content moves to the pop-out window, so the embedded column only
// needs to fit the Coding panel's tag buttons — the freed width goes back
// to the register table.
const VIEWER_OPEN_WIDTH = 260;

export default function Register({ matterName, onSwitchMatter }: Props) {
  const [documents, setDocuments] = useState<DocumentDTO[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [tags, setTags] = useState<Tag[]>([]);

  const [q, setQ] = useState("");
  const [tagFilterIds, setTagFilterIds] = useState<number[]>([]);
  const [mode, setMode] = useState<FilterMode>("all");

  const [selectedGuid, setSelectedGuid] = useState<string | null>(null);
  const [checkedGuids, setCheckedGuids] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("guid");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [rightWidth, setRightWidth] = useState(420);
  const [leftWidth, setLeftWidth] = useState(230);
  const [previewHeight, setPreviewHeight] = useState(420);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    current: number;
    total: number;
    imported: number;
    errors: number;
  } | null>(null);
  const [importFailures, setImportFailures] = useState<Array<{ path: string; error: string }> | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  // Width the column had right before popping out, so docking back restores
  // whatever the user had dragged it to instead of resetting to the default.
  const [preViewerWidth, setPreViewerWidth] = useState(420);

  const refreshDocuments = () => {
    api.listDocuments({ q, tagIds: tagFilterIds, mode }).then(setDocuments);
  };
  const refreshTotalCount = () => {
    api.listDocuments({ q: "", tagIds: [], mode: "any" }).then((docs) => setTotalCount(docs.length));
  };
  const refreshTags = () => {
    api.listTags().then(setTags);
  };

  useEffect(() => {
    refreshTags();
    refreshTotalCount();
  }, []);

  useEffect(() => {
    if (!window.edd) return;
    // Query current state on mount rather than assuming closed — a matter
    // switch remounts this component while the actual OS window (managed
    // by the main process, not this component) may still be open.
    window.edd.isViewerOpen().then(setViewerOpen);
    return window.edd.onViewerStateChange(setViewerOpen);
  }, []);

  useEffect(() => {
    window.edd?.selectInViewer(selectedGuid);
  }, [selectedGuid]);

  useEffect(() => {
    if (viewerOpen) {
      setPreViewerWidth(rightWidth);
      setRightWidth(VIEWER_OPEN_WIDTH);
    } else {
      setRightWidth(preViewerWidth);
    }
    // Deliberately keyed only on the open/closed transition — rightWidth and
    // preViewerWidth are read at that moment, not tracked continuously
    // (which would fight the resize handle and this effect against each other).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerOpen]);

  useEffect(() => {
    const t = setTimeout(refreshDocuments, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tagFilterIds, mode]);

  const sortedDocuments = useMemo(() => {
    const copy = [...documents];
    copy.sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [documents, sortKey, sortDir]);

  const selectedDoc = documents.find((d) => d.guid === selectedGuid) ?? null;
  const codingTargets =
    checkedGuids.size > 0
      ? documents.filter((d) => checkedGuids.has(d.guid))
      : selectedDoc
        ? [selectedDoc]
        : [];

  // Walks the same filtered/sorted order the register table itself shows —
  // not the checked set — so "next"/"previous" matches what's visibly above
  // and below the selected row. selectedGuid driving this (rather than a
  // separate index) also means the arrows automatically stay correct
  // through filtering, sorting, or a document being deleted.
  const selectedIndex = selectedGuid ? sortedDocuments.findIndex((d) => d.guid === selectedGuid) : -1;
  const canGoPrevDocument = selectedIndex > 0;
  const canGoNextDocument = selectedIndex >= 0 && selectedIndex < sortedDocuments.length - 1;

  function goToPrevDocument() {
    if (canGoPrevDocument) setSelectedGuid(sortedDocuments[selectedIndex - 1].guid);
  }
  function goToNextDocument() {
    if (canGoNextDocument) setSelectedGuid(sortedDocuments[selectedIndex + 1].guid);
  }

  const exportGuids = checkedGuids.size > 0 ? Array.from(checkedGuids) : documents.map((d) => d.guid);
  const totalSize = documents.reduce((sum, d) => sum + d.sizeBytes, 0);

  async function doImport(paths: string[]) {
    if (paths.length === 0) return;
    setImporting(true);
    setImportProgress({ current: 0, total: paths.length, imported: 0, errors: 0 });
    setImportFailures(null);
    const failures: Array<{ path: string; error: string }> = [];
    try {
      let completed = 0;
      let imported = 0;
      let errors = 0;

      // One file per request (not the whole batch at once) so progress stays
      // granular and a zip/email that silently expands into many child
      // documents doesn't hide behind a single opaque request. But several
      // requests run concurrently — the server now has a worker pool sized
      // to available CPU cores, so feeding it one file at a time would leave
      // most of that pool idle.
      const CONCURRENCY = 6;
      let nextIndex = 0;
      async function worker() {
        while (nextIndex < paths.length) {
          const i = nextIndex++;
          try {
            const result = await api.importPaths([paths[i]]);
            imported += result.imported.length;
            errors += result.errors.length;
            failures.push(...result.errors);
          } catch (err) {
            errors += 1;
            failures.push({ path: paths[i], error: (err as Error).message });
          }
          completed++;
          setImportProgress({ current: completed, total: paths.length, imported, errors });
          refreshDocuments();
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker));
      refreshTotalCount();
    } finally {
      setImporting(false);
      setImportProgress(null);
      // Unlike the progress banner, this doesn't auto-dismiss — a failed
      // import is exactly the kind of thing that's easy to miss if it just
      // disappears once the batch finishes.
      if (failures.length > 0) setImportFailures(failures);
    }
  }

  async function handleImportClick() {
    if (!window.edd) {
      alert("File picker is only available when running inside the EDD Workbench desktop app.");
      return;
    }
    const paths = await window.edd.pickFiles();
    await doImport(paths);
  }

  async function handlePopOut() {
    if (!window.edd) {
      alert("The pop-out viewer is only available when running inside the EDD Workbench desktop app.");
      return;
    }
    await window.edd.openViewer();
  }

  async function handleDockBack() {
    await window.edd?.closeViewer();
  }

  async function handleSwitchMatter() {
    // The previously-shown document belongs to the matter being left —
    // showing it under the new matter (or worse, a different document that
    // happens to share the same per-matter GUID) would be actively wrong,
    // so close the viewer rather than let it go stale.
    if (viewerOpen) await window.edd?.closeViewer();
    onSwitchMatter();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    if (!window.edd) return;
    const files = Array.from(e.dataTransfer.files);
    const paths = files.map((f) => window.edd.getPathForFile(f));
    void doImport(paths);
  }

  function toggleCheck(guid: string) {
    setCheckedGuids((prev) => {
      const next = new Set(prev);
      if (next.has(guid)) next.delete(guid);
      else next.add(guid);
      return next;
    });
  }

  function toggleCheckAll(checked: boolean) {
    setCheckedGuids(checked ? new Set(sortedDocuments.map((d) => d.guid)) : new Set());
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  async function handleDelete(guid: string) {
    if (!confirm("Delete this document from the register?")) return;
    await api.deleteDocument(guid);
    setCheckedGuids((prev) => {
      const next = new Set(prev);
      next.delete(guid);
      return next;
    });
    if (selectedGuid === guid) setSelectedGuid(null);
    refreshDocuments();
    refreshTotalCount();
  }

  async function handleToggleTag(tag: Tag, turnOn: boolean) {
    const guids = codingTargets.map((d) => d.guid);
    if (guids.length === 0) return;
    await (turnOn ? api.applyTag(guids, tag.id) : api.removeTag(guids, tag.id));
    refreshDocuments();
  }

  async function handleCreateTag(name: string) {
    const tag = await api.createTag(name, tagColorFor(name));
    refreshTags();
    const guids = codingTargets.map((d) => d.guid);
    if (guids.length > 0) {
      await api.applyTag(guids, tag.id);
      refreshDocuments();
    }
  }

  function toggleTagFilter(id: number) {
    setTagFilterIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // Pointer Capture (not plain window-level mousemove/mouseup listeners) —
  // once set, the handle keeps receiving move/up events for this drag no
  // matter where the cursor actually ends up, including right at or past a
  // real OS window's edge. Plain window listeners can silently stop
  // receiving events in that case, which read as the drag "not applying":
  // the pane stops following the cursor and the final position never lands.
  function startColumnResize(
    e: React.PointerEvent<HTMLDivElement>,
    getStart: () => number,
    apply: (next: number) => void,
    sign: 1 | -1,
  ) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startValue = getStart();
    function onMove(ev: PointerEvent) {
      apply(startValue + sign * (ev.clientX - startX));
    }
    function onUp() {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.releasePointerCapture(e.pointerId);
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    startColumnResize(e, () => rightWidth, (next) => setRightWidth(Math.min(720, Math.max(320, next))), -1);
  }

  function startLeftResize(e: React.PointerEvent<HTMLDivElement>) {
    startColumnResize(e, () => leftWidth, (next) => setLeftWidth(Math.min(400, Math.max(160, next))), 1);
  }

  function startPreviewResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = previewHeight;
    function onMove(ev: PointerEvent) {
      const next = startHeight + (ev.clientY - startY);
      setPreviewHeight(Math.min(900, Math.max(120, next)));
    }
    function onUp() {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.releasePointerCapture(e.pointerId);
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="mark">eD</div>
          <div>
            <h1>Register</h1>
            <div className="sub">{matterName}</div>
          </div>
        </div>
        <div className="topbar-stats">
          <div>
            DOCUMENTS <b>{totalCount}</b>
          </div>
          <div>
            FILTERED <b>{documents.length}</b>
          </div>
          <div>
            CHECKED <b>{checkedGuids.size}</b>
          </div>
          <div>
            SIZE <b>{formatSize(totalSize)}</b>
          </div>
        </div>
        <button className="export-btn" style={{ margin: 0, width: "auto" }} onClick={handleSwitchMatter}>
          Switch matter
        </button>
        <button className="ask-btn" onClick={() => setAskOpen(true)}>
          ✦ Ask
        </button>
        <button className="import-btn" disabled={importing} onClick={handleImportClick}>
          {importProgress ? `Importing ${importProgress.current}/${importProgress.total}…` : "+ Import documents"}
        </button>
      </header>

      {importProgress && (
        <div className="import-progress-banner">
          <span className="import-progress-label">
            Importing document {importProgress.current} of {importProgress.total}
            {importProgress.errors > 0 ? ` — ${importProgress.errors} failed` : ""}
          </span>
          <div className="import-progress-track">
            <div
              className="import-progress-fill"
              style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {importFailures && (
        <div className="import-failures-banner">
          <div className="import-failures-head">
            <span className="import-progress-label" style={{ color: "var(--seal)" }}>
              {importFailures.length} file{importFailures.length === 1 ? "" : "s"} failed to import
            </span>
            <button className="row-delete-btn" onClick={() => setImportFailures(null)} title="Dismiss">
              ×
            </button>
          </div>
          <ul className="import-failures-list">
            {importFailures.map((f, i) => (
              <li key={i}>
                <span className="fname">{f.path}</span> — <span className="muted">{f.error}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {askOpen && (
        <AskPanel
          onClose={() => setAskOpen(false)}
          onSelectGuid={(guid) => {
            setSelectedGuid(guid);
            setAskOpen(false);
          }}
        />
      )}

      <main className="layout">
        <FilterPanel
          q={q}
          onQChange={setQ}
          tags={tags}
          tagFilterIds={tagFilterIds}
          onToggleTagFilter={toggleTagFilter}
          mode={mode}
          onModeChange={setMode}
          onClearFilters={() => setTagFilterIds([])}
          exportCount={exportGuids.length}
          checkedCount={checkedGuids.size}
          onExportZip={() => api.exportZip(exportGuids)}
          onExportCsv={() => api.exportCsv(exportGuids)}
          style={{ flexBasis: leftWidth }}
        />

        <div className="col-resize-handle" onPointerDown={startLeftResize} title="Drag to resize" />

        <section className="col-center" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
          <div className="table-toolbar">
            <span className="count">{documents.length} documents</span>
            <span className="drop-hint">Drag files anywhere onto the table to import</span>
          </div>
          <div className="table-wrap">
            <ResultsTable
              documents={sortedDocuments}
              selectedGuid={selectedGuid}
              checkedGuids={checkedGuids}
              sortKey={sortKey}
              sortDir={sortDir}
              onSelect={setSelectedGuid}
              onToggleCheck={toggleCheck}
              onToggleCheckAll={toggleCheckAll}
              onSort={handleSort}
              onDelete={handleDelete}
            />
          </div>
        </section>

        <div className="col-resize-handle" onPointerDown={startResize} title="Drag to resize" />

        <section className="col-right" style={{ flexBasis: rightWidth }}>
          <ErrorBoundary resetKey={selectedGuid}>
            {viewerOpen ? (
              <div className="split-pane" style={{ flex: `0 0 ${previewHeight}px` }}>
                <div className="pane-title-row">
                  <h3 className="pane-title">Preview</h3>
                </div>
                <div className="panel-body">
                  <div className="no-selection">
                    Viewer opened in a separate window.
                    <br />
                    <button className="clear-filters" style={{ marginTop: 10 }} onClick={handleDockBack}>
                      Dock back
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <PreviewPane doc={selectedDoc} onPopOut={handlePopOut} style={{ flex: `0 0 ${previewHeight}px` }} />
            )}
            <div className="row-resize-handle" onPointerDown={startPreviewResize} title="Drag to resize" />
            <CodingPanel
              targets={codingTargets}
              tags={tags}
              onToggleTag={handleToggleTag}
              onCreateTag={handleCreateTag}
              onPrevDocument={goToPrevDocument}
              onNextDocument={goToNextDocument}
              canGoPrevDocument={canGoPrevDocument}
              canGoNextDocument={canGoNextDocument}
            />
          </ErrorBoundary>
        </section>
      </main>
    </div>
  );
}
