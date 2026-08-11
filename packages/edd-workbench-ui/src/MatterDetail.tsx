import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import type { ApiClient } from "./api";
import type { DocumentDTO, TagSetDTO } from "./types";
import { DocumentViewer } from "./DocumentViewer";
import { CodingPanel } from "./CodingPanel";
import { FilterPanel } from "./FilterPanel";
import { DocumentPropertiesPanel } from "./DocumentPropertiesPanel";
import { useViewerWindow } from "./viewer-window/useViewerWindow";
import { useDocumentImport } from "./import/useDocumentImport";
import { formatSize, formatDate } from "./format";

export interface MatterDetailProps {
  api: ApiClient;
  matterId: string;
}

const INGEST_STATUS_COLORS: Record<DocumentDTO["ingestStatus"], string> = {
  pending: "#5B6272",
  processing: "#B4780C",
  ready: "#1F2A44",
  failed: "#A6362C",
};

/**
 * Hand-rolled drag-to-resize via Pointer Capture, matching the POC exactly
 * (pixel-based size + hard min/max clamps, not react-resizable-panels'
 * percentage-based sizing) — `setPointerCapture` keeps delivering move
 * events to the handle even once the pointer leaves it, so a fast drag
 * off the element's bounds doesn't drop the interaction the way plain
 * mouseenter/mouseleave-based dragging would.
 */
function useDragResize(initial: number, min: number, max: number, axis: "x" | "y", direction: 1 | -1) {
  const [size, setSize] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ pos: 0, size: initial });

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { pos: axis === "x" ? e.clientX : e.clientY, size };
    setDragging(true);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    const pos = axis === "x" ? e.clientX : e.clientY;
    const delta = (pos - startRef.current.pos) * direction;
    setSize(Math.min(max, Math.max(min, startRef.current.size + delta)));
  }
  function endDrag(e: ReactPointerEvent<HTMLDivElement>) {
    setDragging(false);
    // A drag that never moved (a plain click) never actually captured the
    // pointer in some browsers' interpretation — releasing an uncaptured
    // pointer id throws, hence the guard.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  return { size, dragging, onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag };
}

export function MatterDetail({ api, matterId }: MatterDetailProps) {
  const [documents, setDocuments] = useState<DocumentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  // Fully independent of selectedDocumentId (which drives the single-doc
  // preview) — this is the bulk-coding/export selection. Deliberately not
  // pruned when a search/tag filter hides a row; see the toolbar's
  // visible/hidden count split below.
  const [checkedDocumentIds, setCheckedDocumentIds] = useState<Set<string>>(new Set());

  function toggleChecked(documentId: string) {
    setCheckedDocumentIds((prev) => {
      const next = new Set(prev);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  }

  // Selects/clears only the currently-visible (filtered) documents —
  // leaves any hidden-but-checked ids from a previous filter untouched,
  // same reasoning as toggleChecked's own visible/hidden split.
  function toggleSelectAllVisible(visibleDocuments: DocumentDTO[]) {
    const allVisibleChecked = visibleDocuments.length > 0 && visibleDocuments.every((d) => checkedDocumentIds.has(d.documentId));
    setCheckedDocumentIds((prev) => {
      const next = new Set(prev);
      for (const doc of visibleDocuments) {
        if (allVisibleChecked) next.delete(doc.documentId);
        else next.add(doc.documentId);
      }
      return next;
    });
  }

  const [tagSets, setTagSets] = useState<TagSetDTO[]>([]);
  const [appliedTagsByDocument, setAppliedTagsByDocument] = useState<Record<string, string[]>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagMatchMode, setTagMatchMode] = useState<"all" | "any">("all");

  const leftResize = useDragResize(230, 160, 400, "x", 1);
  const rightResize = useDragResize(420, 320, 720, "x", -1);
  const rowResize = useDragResize(420, 120, 900, "y", 1);

  function refreshDocuments() {
    api.getMatterDocuments(matterId).then(setDocuments).catch((err) => setError(err.message));
  }

  useEffect(refreshDocuments, [matterId]);

  function refreshTagState() {
    api.getTagSets(matterId).then(setTagSets).catch((err) => setError(err.message));
    api.getAllDocumentTags(matterId).then(setAppliedTagsByDocument).catch((err) => setError(err.message));
  }

  useEffect(refreshTagState, [matterId]);

  const tagsById = new Map(tagSets.flatMap((tagSet) => tagSet.tags).map((tag) => [tag.id, tag]));

  async function handleDeleteDocument(doc: DocumentDTO) {
    // Checks parentGuid (the direct-parent link), not familyGuid — familyGuid
    // is now the whole family tree's root (see types.ts), so it stays the
    // same at every depth and would silently stop matching for a middle-of-
    // tree node (e.g. deleting a PST message that itself has an attachment)
    // even though the cascade still deletes its descendants.
    const hasChildren = documents?.some((d) => d.parentGuid === doc.guid) ?? false;
    const warning = hasChildren ? " Its attachments will be deleted too." : "";
    if (!window.confirm(`Delete "${doc.originalFilename}"?${warning} This cannot be undone.`)) return;
    try {
      await api.deleteDocument(matterId, doc.documentId);
      if (selectedDocumentId === doc.documentId) setSelectedDocumentId(null);
      setCheckedDocumentIds((prev) => {
        if (!prev.has(doc.documentId)) return prev;
        const next = new Set(prev);
        next.delete(doc.documentId);
        return next;
      });
      refreshDocuments();
      refreshTagState();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const filteredDocuments =
    documents?.filter((doc) => {
      const matchesSearch = searchQuery.trim().length === 0 || doc.originalFilename.toLowerCase().includes(searchQuery.trim().toLowerCase());
      if (!matchesSearch) return false;
      if (selectedTagIds.length === 0) return true;
      const appliedIds = appliedTagsByDocument[doc.documentId] ?? [];
      return tagMatchMode === "all" ? selectedTagIds.every((id) => appliedIds.includes(id)) : selectedTagIds.some((id) => appliedIds.includes(id));
    }) ?? null;

  const visibleCheckedCount = filteredDocuments?.filter((d) => checkedDocumentIds.has(d.documentId)).length ?? 0;
  const hiddenCheckedCount = checkedDocumentIds.size - visibleCheckedCount;

  const selectedDocument = filteredDocuments?.find((d) => d.documentId === selectedDocumentId) ?? null;
  const selectedIndex = filteredDocuments?.findIndex((d) => d.documentId === selectedDocumentId) ?? -1;
  // Walks the *filtered/displayed* list, not the full matter — matches what
  // the reviewer is actually looking at. Server-ordered by guid_number (see
  // documents.ts's list route) and unpaginated for now; once Milestone 3
  // adds pagination this needs to walk the displayed page's order instead,
  // same caveat as before, now doubly true with client-side filtering too.
  const goToPrev = () => {
    if (filteredDocuments && selectedIndex > 0) setSelectedDocumentId(filteredDocuments[selectedIndex - 1].documentId);
  };
  const goToNext = () => {
    if (filteredDocuments && selectedIndex >= 0 && selectedIndex < filteredDocuments.length - 1) {
      setSelectedDocumentId(filteredDocuments[selectedIndex + 1].documentId);
    }
  };

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((ids) => (ids.includes(tagId) ? ids.filter((id) => id !== tagId) : [...ids, tagId]));
  }

  const viewerWindow = useViewerWindow(matterId, selectedDocumentId);
  const documentImport = useDocumentImport(api, matterId, refreshDocuments);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function handleFilesPicked(fileList: FileList | null) {
    if (fileList && fileList.length > 0) documentImport.importFiles(Array.from(fileList));
  }

  function handleDragOver(e: ReactDragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(true);
  }
  function handleDragLeave() {
    setDragOver(false);
  }
  function handleDrop(e: ReactDragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    handleFilesPicked(e.dataTransfer.files);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {error && (
        <div className="import-failures-banner">
          <div className="import-failures-head">
            <span>{error}</span>
            <button type="button" className="row-delete-btn" onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      )}

      {documentImport.importProgress && (
        <div className="import-progress-banner">
          <span className="import-progress-label">
            Importing document {documentImport.importProgress.current} of {documentImport.importProgress.total}
            {documentImport.importProgress.errors > 0 ? ` — ${documentImport.importProgress.errors} failed` : ""}
          </span>
          <div className="import-progress-track">
            <div
              className="import-progress-fill"
              style={{ width: `${(documentImport.importProgress.current / documentImport.importProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {documentImport.ingestProgress && (
        <div className="import-progress-banner">
          <span className="import-progress-label">
            {documentImport.ingestProgress.gaveUp
              ? `${documentImport.ingestProgress.remaining} document${documentImport.ingestProgress.remaining === 1 ? "" : "s"} still processing — reload to check`
              : `Processing ${documentImport.ingestProgress.total - documentImport.ingestProgress.remaining} of ${documentImport.ingestProgress.total} document${documentImport.ingestProgress.total === 1 ? "" : "s"}…`}
            {documentImport.ingestProgress.failed > 0 ? ` — ${documentImport.ingestProgress.failed} failed` : ""}
          </span>
          <div className="import-progress-track">
            <div
              className="import-progress-fill"
              style={{
                width: `${((documentImport.ingestProgress.total - documentImport.ingestProgress.remaining) / documentImport.ingestProgress.total) * 100}%`,
              }}
            />
          </div>
          {(documentImport.ingestProgress.gaveUp || documentImport.ingestProgress.failed > 0) && (
            <button type="button" className="row-delete-btn" onClick={documentImport.dismissIngestProgress} aria-label="Dismiss">
              ×
            </button>
          )}
        </div>
      )}

      {documentImport.importFailures && (
        <div className="import-failures-banner">
          <div className="import-failures-head">
            <span>
              {documentImport.importFailures.length} file{documentImport.importFailures.length === 1 ? "" : "s"} failed to import
            </span>
            <button type="button" className="row-delete-btn" onClick={documentImport.dismissFailures} aria-label="Dismiss">
              ×
            </button>
          </div>
          <ul className="import-failures-list">
            {documentImport.importFailures.map((failure, i) => (
              <li key={i}>
                <span className="fname">{failure.filename}</span> <span className="muted">— {failure.error}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!documents || !filteredDocuments ? (
        <p className="empty-note" style={{ padding: 16 }}>
          Loading…
        </p>
      ) : (
        <main className="layout" style={{ flex: 1, minHeight: 0 }}>
          <FilterPanel
            api={api}
            matterId={matterId}
            style={{ flexBasis: leftResize.size }}
            tagSets={tagSets}
            appliedTagsByDocument={appliedTagsByDocument}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            selectedTagIds={selectedTagIds}
            onToggleTagId={toggleTagFilter}
            matchMode={tagMatchMode}
            onMatchModeChange={setTagMatchMode}
            onClearTagFilter={() => setSelectedTagIds([])}
            selectedDocumentIds={Array.from(checkedDocumentIds)}
          />

          <div className={`col-resize-handle${leftResize.dragging ? " dragging" : ""}`} {...leftResize} />

          <section className="col col-center">
            <div className="table-toolbar">
              <span className="count">
                {filteredDocuments.length} of {documents.length} document{documents.length === 1 ? "" : "s"}
              </span>
              {checkedDocumentIds.size > 0 && (
                <span className="count">
                  {visibleCheckedCount} selected
                  {hiddenCheckedCount > 0 ? ` (${hiddenCheckedCount} not shown by current filter)` : ""}
                  <button type="button" className="clear-filters" onClick={() => setCheckedDocumentIds(new Set())}>
                    Clear
                  </button>
                </span>
              )}
              <button type="button" className="import-btn" disabled={documentImport.importing} onClick={() => fileInputRef.current?.click()}>
                {documentImport.importProgress
                  ? `Importing ${documentImport.importProgress.current}/${documentImport.importProgress.total}…`
                  : "+ Import documents"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  handleFilesPicked(e.target.files);
                  // Without this, picking the exact same file(s) again later
                  // wouldn't fire another change event at all.
                  e.target.value = "";
                }}
              />
              <span className="drop-hint">Drag files here to import</span>
            </div>
            <div className={`table-wrap${dragOver ? " drag-over" : ""}`} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
              {filteredDocuments.length === 0 ? (
                <div className="empty-state">
                  <div className="glyph">000000</div>
                  <h3>{documents.length === 0 ? "No documents yet." : "No documents match the current filters."}</h3>
                  <p>
                    {documents.length === 0
                      ? "Documents uploaded to this matter will appear here once ingested."
                      : "Try clearing the search or tag filter."}
                  </p>
                </div>
              ) : (
                <table className="reg">
                  <colgroup>
                    <col style={{ width: 32 }} />
                    <col style={{ width: 80 }} />
                    <col style={{ width: 80 }} />
                    <col />
                    <col style={{ width: 55 }} />
                    <col style={{ width: 70 }} />
                    <col style={{ width: 90 }} />
                    <col style={{ width: 90 }} />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 100 }} />
                    <col style={{ width: 150 }} />
                    <col style={{ width: 32 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="selectcell">
                        <input
                          type="checkbox"
                          checked={filteredDocuments.length > 0 && filteredDocuments.every((d) => checkedDocumentIds.has(d.documentId))}
                          ref={(el) => {
                            if (el) {
                              const anyChecked = filteredDocuments.some((d) => checkedDocumentIds.has(d.documentId));
                              const allChecked = filteredDocuments.length > 0 && filteredDocuments.every((d) => checkedDocumentIds.has(d.documentId));
                              el.indeterminate = anyChecked && !allChecked;
                            }
                          }}
                          onChange={() => toggleSelectAllVisible(filteredDocuments)}
                          aria-label="Select all"
                        />
                      </th>
                      <th>GUID</th>
                      <th>Family GUID</th>
                      <th>Filename</th>
                      <th>Type</th>
                      <th>Size</th>
                      <th>Date</th>
                      <th>Date Modified</th>
                      <th>Author</th>
                      <th>To</th>
                      <th>Cc</th>
                      <th>Tags</th>
                      <th className="checkcell"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDocuments.map((doc) => {
                      const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
                      const to = typeof metadata.to === "string" ? metadata.to : null;
                      const cc = typeof metadata.cc === "string" ? metadata.cc : null;
                      const appliedTagIds = appliedTagsByDocument[doc.documentId] ?? [];
                      return (
                        <tr
                          key={doc.documentId}
                          className={doc.documentId === selectedDocumentId ? "active" : ""}
                          onClick={() => setSelectedDocumentId(doc.documentId)}
                        >
                          <td className="selectcell" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={checkedDocumentIds.has(doc.documentId)}
                              onChange={() => toggleChecked(doc.documentId)}
                              aria-label={`Select ${doc.originalFilename}`}
                            />
                          </td>
                          <td className="guid">{doc.guid}</td>
                          <td className="muted">{doc.familyGuid}</td>
                          <td
                            className="fname"
                            title={doc.depth > 0 ? `Attached to ${doc.parentGuid}` : doc.originalFilename}
                            style={doc.depth > 0 ? { paddingLeft: 10 + doc.depth * 16 } : undefined}
                          >
                            {doc.depth > 0 && <span className="muted">↳ </span>}
                            {doc.originalFilename}
                          </td>
                          <td className="muted">{doc.extension}</td>
                          <td className="muted">{formatSize(doc.sizeBytes)}</td>
                          <td className="muted">{formatDate(doc.docDate)}</td>
                          <td className="muted">{formatDate(doc.fileModifiedAt)}</td>
                          <td className="muted">{doc.author ?? "—"}</td>
                          <td className="muted">{to ?? "—"}</td>
                          <td className="muted">{cc ?? "—"}</td>
                          <td>
                            <div className="tagchips">
                              <span
                                className="chip"
                                style={{ background: `${INGEST_STATUS_COLORS[doc.ingestStatus]}22`, color: INGEST_STATUS_COLORS[doc.ingestStatus] }}
                              >
                                {doc.ingestStatus}
                              </span>
                              {appliedTagIds.map((tagId) => {
                                const tag = tagsById.get(tagId);
                                if (!tag) return null;
                                const style = tag.color
                                  ? { background: `${tag.color}22`, color: tag.color }
                                  : { background: "var(--slate-soft)", color: "var(--ink-soft)" };
                                return (
                                  <span key={tagId} className="chip" style={style}>
                                    {tag.name}
                                  </span>
                                );
                              })}
                            </div>
                          </td>
                          <td className="checkcell">
                            <button
                              type="button"
                              className="row-delete-btn"
                              aria-label={`Delete ${doc.originalFilename}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteDocument(doc);
                              }}
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <div className={`col-resize-handle${rightResize.dragging ? " dragging" : ""}`} {...rightResize} />

          <section className="col col-right" style={{ flexBasis: rightResize.size }}>
            {selectedDocument && (
              <div className="pane-title-row">
                <h2 className="panel-title">Preview</h2>
                {viewerWindow.state === "docked" ? (
                  <>
                    {viewerWindow.pipSupported && (
                      <button type="button" className="pop-out-btn" onClick={viewerWindow.popOutPiP}>
                        ⧉ Float on top
                      </button>
                    )}
                    <button type="button" className="pop-out-btn" onClick={() => viewerWindow.popOut(selectedDocument.documentId)}>
                      ⧉ Pop out
                    </button>
                  </>
                ) : (
                  <button type="button" className="pop-out-btn" onClick={viewerWindow.dockBack}>
                    Dock back
                  </button>
                )}
              </div>
            )}
            {viewerWindow.popOutError && <p className="preview-unsupported">{viewerWindow.popOutError}</p>}
            <div className="panel-body" style={{ flexBasis: rowResize.size, flexGrow: 0, flexShrink: 0 }}>
              {!selectedDocument ? (
                <p className="no-selection">Select a document to preview it.</p>
              ) : viewerWindow.state === "open" ? (
                <>
                  <DocumentPropertiesPanel document={selectedDocument} />
                  <p className="no-selection">Viewer opened in a separate window.</p>
                </>
              ) : viewerWindow.state === "pip" ? (
                <>
                  <DocumentPropertiesPanel document={selectedDocument} />
                  <p className="no-selection">Viewer floating in picture-in-picture.</p>
                </>
              ) : (
                <>
                  <DocumentPropertiesPanel document={selectedDocument} />
                  <DocumentViewer api={api} matterId={matterId} document={selectedDocument} />
                </>
              )}
            </div>
            {selectedDocument &&
              viewerWindow.pipContainer &&
              createPortal(
                <>
                  <DocumentPropertiesPanel document={selectedDocument} />
                  <DocumentViewer api={api} matterId={matterId} document={selectedDocument} />
                </>,
                viewerWindow.pipContainer,
              )}
            {selectedDocument && (
              <>
                <div className={`row-resize-handle${rowResize.dragging ? " dragging" : ""}`} {...rowResize} />
                <CodingPanel
                  api={api}
                  matterId={matterId}
                  documentId={selectedDocument.documentId}
                  bulkSelectedDocumentIds={Array.from(checkedDocumentIds)}
                  onClearBulkSelection={() => setCheckedDocumentIds(new Set())}
                  tagSets={tagSets}
                  onTagsChanged={refreshTagState}
                  onPrev={goToPrev}
                  onNext={goToNext}
                  canGoPrev={selectedIndex > 0}
                  canGoNext={selectedIndex >= 0 && selectedIndex < filteredDocuments.length - 1}
                />
              </>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
