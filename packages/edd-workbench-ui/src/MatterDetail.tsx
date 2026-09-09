import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { ApiClient } from "./api";
import type { DocumentDTO, TagSetDTO, AskResultDTO } from "./types";
import { DocumentViewer } from "./DocumentViewer";
import { CodingPanel } from "./CodingPanel";
import { AskResultPanel } from "./AskResultPanel";
import { FilterPanel, type IngestStatusFilter } from "./FilterPanel";
import { DocumentPropertiesPanel } from "./DocumentPropertiesPanel";
import { useViewerWindow } from "./viewer-window/useViewerWindow";
import { useDocumentImport } from "./import/useDocumentImport";
import { formatSize, formatDate, displayFilename, stripExtension } from "./format";
import { sortDocuments, type SortableColumn, type SortDirection } from "./sortDocuments";
import { ConfirmDialog } from "./ConfirmDialog";

export interface MatterDetailProps {
  api: ApiClient;
  matterId: string;
  /** Admin, or this matter's own creator — gates the access-list panel's add/remove controls (see FilterPanel.tsx). */
  canManageAccess: boolean;
  /** Passed straight through to FilterPanel — see its own props doc. */
  currentUserId: string;
  matterCreatedBy: string | null;
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

type DocumentColumnKey =
  | "guid"
  | "familyGuid"
  | "originalFilename"
  | "extension"
  | "sizeBytes"
  | "docDate"
  | "author"
  | "contentModifiedAt"
  | "toAddresses"
  | "ccAddresses"
  | "tags";

// Preferred widths for every resizable column EXCEPT filename — filename is
// the one column that absorbs whatever space is actually available (see
// fitToContainer below), not a fixed preference.
const PREFERRED_COLUMN_WIDTHS: Omit<Record<DocumentColumnKey, number>, "originalFilename"> = {
  guid: 80,
  familyGuid: 80,
  extension: 55,
  sizeBytes: 70,
  docDate: 90,
  author: 130,
  contentModifiedAt: 90,
  toAddresses: 150,
  ccAddresses: 150,
  tags: 150,
};

const MIN_COLUMN_WIDTH = 40;
// The two non-resizable columns (checkbox, per-row delete) — needed to
// compute how much width is actually left for the resizable ones.
const SELECT_CELL_WIDTH = 32;
const CHECK_CELL_WIDTH = 32;

const DEFAULT_COLUMN_WIDTHS: Record<DocumentColumnKey, number> = { ...PREFERRED_COLUMN_WIDTHS, originalFilename: 220 };

/**
 * Independent per-column drag-to-resize, same Pointer Capture mechanics as
 * useDragResize above but keyed by column rather than a single dimension —
 * one shared drag ref (only one column can be dragged at a time) instead of
 * instantiating useDragResize once per column, which would mean a fixed,
 * unrollable number of hook calls for however many columns this table ends
 * up with.
 *
 * Also owns "fit the columns to the panel's actual width" — every other
 * column keeps its preferred width and the filename column absorbs
 * whatever's left over (shrinking it if necessary), so the table needs no
 * horizontal scrollbar on a fresh load regardless of screen size. This
 * auto-fit re-runs whenever the matter changes or the panel itself is
 * resized (dragging the left/right panel handles, or the browser window) —
 * but ONLY until the user manually drags a column's own resize handle, at
 * which point their explicit choice takes over and a scrollbar is the
 * expected result of a table now wider than the panel, not something to
 * silently fight by auto-shrinking things back.
 */
function useColumnWidths(matterId: string) {
  const [widths, setWidths] = useState<Record<DocumentColumnKey, number>>(DEFAULT_COLUMN_WIDTHS);
  const [draggingColumn, setDraggingColumn] = useState<DocumentColumnKey | null>(null);
  const dragRef = useRef({ column: null as DocumentColumnKey | null, startX: 0, startWidth: 0 });
  const manuallyResizedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const fitToContainer = useCallback(() => {
    if (manuallyResizedRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const preferredTotal = Object.values(PREFERRED_COLUMN_WIDTHS).reduce((sum, w) => sum + w, 0);
    // -2px slack against border/rounding so fitting exactly never itself
    // triggers a 1px scrollbar sliver.
    const available = container.clientWidth - SELECT_CELL_WIDTH - CHECK_CELL_WIDTH - preferredTotal - 2;
    setWidths({ ...PREFERRED_COLUMN_WIDTHS, originalFilename: Math.max(MIN_COLUMN_WIDTH, available) });
  }, []);

  // Layout effect, not a plain effect — this measures and sets widths that
  // affect visible layout immediately; running before the browser's first
  // paint of the new matter avoids a brief flash of the previous/default
  // widths before snapping to the fitted ones.
  useLayoutEffect(() => {
    manuallyResizedRef.current = false;
    fitToContainer();
  }, [matterId, fitToContainer]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(fitToContainer);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [fitToContainer]);

  function startResize(column: DocumentColumnKey) {
    return (e: ReactPointerEvent<HTMLDivElement>) => {
      // Otherwise a plain click-without-drag on the handle would bubble up
      // and toggle sort on the SortableTh it sits inside.
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      manuallyResizedRef.current = true;
      dragRef.current = { column, startX: e.clientX, startWidth: widths[column] };
      setDraggingColumn(column);
    };
  }
  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag.column) return;
    const next = Math.max(MIN_COLUMN_WIDTH, drag.startWidth + (e.clientX - drag.startX));
    setWidths((prev) => ({ ...prev, [drag.column!]: next }));
  }
  function endResize(e: ReactPointerEvent<HTMLDivElement>) {
    dragRef.current.column = null;
    setDraggingColumn(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  return { widths, draggingColumn, startResize, onMove, endResize, containerRef };
}

interface ColumnResizeHandleProps {
  column: DocumentColumnKey;
  columnWidths: ReturnType<typeof useColumnWidths>;
}

function ColumnResizeHandle({ column, columnWidths }: ColumnResizeHandleProps) {
  return (
    <div
      className={`col-resize-th-handle${columnWidths.draggingColumn === column ? " dragging" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={columnWidths.startResize(column)}
      onPointerMove={columnWidths.onMove}
      onPointerUp={columnWidths.endResize}
      onPointerCancel={columnWidths.endResize}
    />
  );
}

interface SortableThProps {
  column: SortableColumn;
  sortColumn: SortableColumn | null;
  sortDirection: SortDirection;
  onSort: (column: SortableColumn) => void;
  resizeHandle: ReactNode;
  children: ReactNode;
}

/**
 * A clickable `<th>` that toggles ascending/descending sort on its own
 * column. Every `<th>` in this table already gets `cursor: pointer` from
 * table.reg's own base styles.css rule, and a `.sorted` class is already
 * styled there too (`color: var(--navy)`) — both clearly prepared for
 * this exact feature already, just never wired up to real behavior until
 * now, so this reuses that existing class rather than inventing a new one.
 */
function SortableTh({ column, sortColumn, sortDirection, onSort, resizeHandle, children }: SortableThProps) {
  const active = sortColumn === column;
  return (
    <th
      className={active ? "sorted" : undefined}
      onClick={() => onSort(column)}
      aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
    >
      {children}
      {active ? (sortDirection === "asc" ? " ▲" : " ▼") : null}
      {resizeHandle}
    </th>
  );
}

export function MatterDetail({ api, matterId, canManageAccess, currentUserId, matterCreatedBy }: MatterDetailProps) {
  const [documents, setDocuments] = useState<DocumentDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [askResult, setAskResult] = useState<AskResultDTO | null>(null);
  // Independent of matchingDocumentIds (search) — combined via AND in
  // filteredDocuments below, same as the existing status/tag filters, so
  // asking a question doesn't clobber (or get clobbered by) an active
  // search. null = no active ask result, don't restrict the table.
  const [askRelevantDocumentIds, setAskRelevantDocumentIds] = useState<Set<string> | null>(null);

  function handleAskResult(result: AskResultDTO | null) {
    setAskResult(result);
    setAskRelevantDocumentIds(result ? new Set(result.relevantDocuments.map((d) => d.documentId)) : null);
  }
  // Not pruned when a search/tag filter hides a row; see the toolbar's
  // visible/hidden count split below. Only the checkbox column
  // (handleCheckboxClick) drives this — a row click just selects/previews
  // the document (see the row's own onClick), it doesn't check/uncheck it.
  const [checkedDocumentIds, setCheckedDocumentIds] = useState<Set<string>>(new Set());
  // The last plain (non-shift) checkbox click that set the selection
  // anchor — what a subsequent shift-click ranges *from*. Deliberately
  // doesn't move on a shift-click itself (standard file-manager convention:
  // click 3, shift-click 7 selects 3-7; a further shift-click 1 selects
  // 1-3, ranging from the original anchor at 3, not from 7) — repeated
  // shift-clicks stay anchored to the same starting row until the next
  // plain click.
  const [checkboxAnchorId, setCheckboxAnchorId] = useState<string | null>(null);
  // Captured on the checkbox's own onClick (see below) so onChange — which
  // is what actually drives the check/uncheck — knows whether shift was
  // held. A ref, not state: this is read once, synchronously, by the very
  // next event in the same click, never across a render.
  const checkboxShiftKeyRef = useRef(false);

  function toggleChecked(documentId: string) {
    setCheckedDocumentIds((prev) => {
      const next = new Set(prev);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  }

  // Shared shift-click range logic for both row clicks and checkbox clicks:
  // everything between the anchor and the clicked row (inclusive, in
  // current sorted/visible row order) gets added to the existing selection
  // — anything already checked outside that range stays checked, matching
  // the standard OS file-manager convention. Returns false (meaning: no
  // live anchor to range from — first-ever click, or the anchor row got
  // filtered/sorted out) so the caller can fall back to its own
  // non-shift-click behavior instead.
  function extendCheckedRange(documentId: string, visibleDocuments: DocumentDTO[]): boolean {
    if (!checkboxAnchorId) return false;
    const anchorIndex = visibleDocuments.findIndex((d) => d.documentId === checkboxAnchorId);
    const clickedIndex = visibleDocuments.findIndex((d) => d.documentId === documentId);
    if (anchorIndex === -1 || clickedIndex === -1) return false;
    const [start, end] = anchorIndex <= clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex];
    setCheckedDocumentIds((prev) => {
      const next = new Set(prev);
      for (let i = start; i <= end; i++) next.add(visibleDocuments[i].documentId);
      return next;
    });
    return true;
  }

  // The checkbox column is the only thing that checks/unchecks a document.
  // A plain checkbox click toggles just this one row's *checked* state
  // (add or remove), leaving every other checked row alone. Shift
  // range-extends from the last plain-clicked checkbox, same file-manager
  // convention as a shift-click anywhere else. Its own click handler also
  // sets selectedDocumentId, same as a row click, so checking a row also
  // previews it — only the checked-set semantics differ, not whether it
  // selects/previews the row.
  function handleCheckboxClick(documentId: string, shiftKey: boolean, visibleDocuments: DocumentDTO[]) {
    if (shiftKey && extendCheckedRange(documentId, visibleDocuments)) return;
    toggleChecked(documentId);
    setCheckboxAnchorId(documentId);
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
  // null = no active search (show everything, today's empty-query
  // behavior) — distinct from an empty Set, which would mean "searched,
  // zero matches."
  const [matchingDocumentIds, setMatchingDocumentIds] = useState<Set<string> | null>(null);
  const [searchTotalHits, setSearchTotalHits] = useState<number | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<IngestStatusFilter>("all");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagMatchMode, setTagMatchMode] = useState<"all" | "any">("all");
  const [sortColumn, setSortColumn] = useState<SortableColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  function toggleSort(column: SortableColumn) {
    if (sortColumn !== column) {
      setSortColumn(column);
      setSortDirection("asc");
      return;
    }
    setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
  }

  const leftResize = useDragResize(230, 160, 400, "x", 1);
  const rightResize = useDragResize(420, 320, 720, "x", -1);
  const rowResize = useDragResize(420, 120, 900, "y", 1);
  const columnWidths = useColumnWidths(matterId);

  function refreshDocuments() {
    api.getMatterDocuments(matterId).then(setDocuments).catch((err) => setError(err.message));
  }

  useEffect(refreshDocuments, [matterId]);

  // Debounced so a real backend request isn't fired on every keystroke —
  // Elasticsearch-backed, replacing the old client-side filename filter
  // entirely (see FilterPanel.tsx's own updated comment).
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setMatchingDocumentIds(null);
      setSearchTotalHits(null);
      setSearchError(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchDocuments(matterId, trimmed)
        .then((result) => {
          setMatchingDocumentIds(new Set(result.documentIds));
          setSearchTotalHits(result.totalHits);
          setSearchError(null);
        })
        .catch((err) => {
          // Falls back to showing the unfiltered list (matchesSearch below
          // treats a still-null matchingDocumentIds as "no filter") rather
          // than blocking the whole panel on a search-service hiccup.
          setMatchingDocumentIds(null);
          setSearchTotalHits(null);
          setSearchError((err as Error).message);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [api, matterId, searchQuery]);

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

  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  async function handleBulkDelete() {
    setShowBulkDeleteConfirm(false);
    try {
      const idsToDelete = Array.from(checkedDocumentIds);
      await api.bulkDeleteDocuments(matterId, idsToDelete);
      if (selectedDocumentId && checkedDocumentIds.has(selectedDocumentId)) setSelectedDocumentId(null);
      setCheckedDocumentIds(new Set());
      refreshDocuments();
      refreshTagState();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const filteredDocuments =
    documents?.filter((doc) => {
      const matchesSearch = matchingDocumentIds === null || matchingDocumentIds.has(doc.documentId);
      if (!matchesSearch) return false;
      const matchesAsk = askRelevantDocumentIds === null || askRelevantDocumentIds.has(doc.documentId);
      if (!matchesAsk) return false;
      if (statusFilter === "ocr") {
        if (doc.ocrStatus !== "ready") return false;
      } else if (statusFilter !== "all" && doc.ingestStatus !== statusFilter) {
        return false;
      }
      if (selectedTagIds.length === 0) return true;
      const appliedIds = appliedTagsByDocument[doc.documentId] ?? [];
      return tagMatchMode === "all" ? selectedTagIds.every((id) => appliedIds.includes(id)) : selectedTagIds.some((id) => appliedIds.includes(id));
    }) ?? null;

  const visibleCheckedCount = filteredDocuments?.filter((d) => checkedDocumentIds.has(d.documentId)).length ?? 0;
  const hiddenCheckedCount = checkedDocumentIds.size - visibleCheckedCount;
  // Sum over the FILTERED set (the current working view), not the whole
  // matter — matches what "FILTERED" already narrows the table to.
  const totalFilteredSizeBytes = filteredDocuments?.reduce((sum, d) => sum + d.sizeBytes, 0) ?? 0;

  // Same elements as filteredDocuments, just reordered — used for
  // everything render/navigation-facing below so Prev/Next and the table's
  // own row order both match whatever the reviewer actually sees after a
  // column-header sort, not the underlying filtered-but-unsorted order.
  const sortedDocuments = filteredDocuments && sortColumn ? sortDocuments(filteredDocuments, sortColumn, sortDirection) : filteredDocuments;

  const selectedDocument = sortedDocuments?.find((d) => d.documentId === selectedDocumentId) ?? null;
  const selectedIndex = sortedDocuments?.findIndex((d) => d.documentId === selectedDocumentId) ?? -1;
  // Walks the *filtered/displayed* list, not the full matter — matches what
  // the reviewer is actually looking at. Server-ordered by guid_number (see
  // documents.ts's list route) and unpaginated for now; once Milestone 3
  // adds pagination this needs to walk the displayed page's order instead,
  // same caveat as before, now doubly true with client-side filtering too.
  const goToPrev = () => {
    if (sortedDocuments && selectedIndex > 0) setSelectedDocumentId(sortedDocuments[selectedIndex - 1].documentId);
  };
  const goToNext = () => {
    if (sortedDocuments && selectedIndex >= 0 && selectedIndex < sortedDocuments.length - 1) {
      setSelectedDocumentId(sortedDocuments[selectedIndex + 1].documentId);
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

  // Whole-window drop target, not just the document table — native
  // listeners on window, not React's synthetic onDragOver/onDrop on one
  // div, since "anywhere in the window" includes the side panels/toolbar
  // too. dragover must call preventDefault() or the browser's own default
  // (navigate to the dropped file) wins instead of firing a drop event at
  // all. dragCounter (not a plain boolean) is the standard fix for
  // dragenter/dragleave firing once per child element as the pointer
  // crosses them while dragging across a large, deeply-nested region —
  // without it, the overlay would flicker on/off while dragging over the
  // table's own rows.
  useEffect(() => {
    let dragCounter = 0;
    function isFileDrag(e: DragEvent): boolean {
      return !!e.dataTransfer?.types.includes("Files");
    }
    function onWindowDragEnter(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragCounter++;
      setDragOver(true);
    }
    function onWindowDragOver(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
    }
    function onWindowDragLeave(e: DragEvent) {
      if (!isFileDrag(e)) return;
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) setDragOver(false);
    }
    function onWindowDrop(e: DragEvent) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragCounter = 0;
      setDragOver(false);
      handleFilesPicked(e.dataTransfer?.files ?? null);
    }
    window.addEventListener("dragenter", onWindowDragEnter);
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("dragleave", onWindowDragLeave);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragenter", onWindowDragEnter);
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("dragleave", onWindowDragLeave);
      window.removeEventListener("drop", onWindowDrop);
    };
  }, [documentImport.importFiles]);

  return (
    // width:100%/minWidth:0 — this div is the sole child of the OUTER
    // main.layout (EddWorkbenchWorkspace.tsx), a row-direction flex
    // container. With no flex-grow and no explicit width, this div's width
    // was purely content-driven: narrow when the table has no rows to show
    // (the whole 3-column layout shrinks, pulling the right panel in from
    // the screen edge), and — the opposite problem — unbounded when a
    // resized table wants to be very wide (nothing here anchors it to the
    // viewport, so the resized table pushes the whole layout wider instead
    // of scrolling internally within .table-wrap). A definite width here is
    // what makes every downstream overflow/containment rule (col-center's
    // own overflow:hidden, .table-wrap's overflow:auto) behave as intended.
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", minWidth: 0, minHeight: 0 }}>
      {dragOver && (
        <div className="drop-overlay">
          <span>Drop files to import</span>
        </div>
      )}
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

      {!documents || !filteredDocuments || !sortedDocuments ? (
        <p className="empty-note" style={{ padding: 16 }}>
          Loading…
        </p>
      ) : (
        <main className="layout" style={{ flex: 1, minHeight: 0 }}>
          <FilterPanel
            api={api}
            matterId={matterId}
            canManageAccess={canManageAccess}
            currentUserId={currentUserId}
            matterCreatedBy={matterCreatedBy}
            style={{ flexBasis: leftResize.size }}
            tagSets={tagSets}
            appliedTagsByDocument={appliedTagsByDocument}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            searchError={searchError}
            searchTotalHits={searchTotalHits}
            matchingDocumentCount={matchingDocumentIds?.size ?? null}
            selectedTagIds={selectedTagIds}
            onToggleTagId={toggleTagFilter}
            matchMode={tagMatchMode}
            onMatchModeChange={setTagMatchMode}
            onClearTagFilter={() => setSelectedTagIds([])}
            selectedDocumentIds={Array.from(checkedDocumentIds)}
            documents={documents}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            onDocumentsChanged={refreshDocuments}
            onAskResult={handleAskResult}
          />

          <div className={`col-resize-handle${leftResize.dragging ? " dragging" : ""}`} {...leftResize} />

          <section className="col col-center">
            <div className="table-toolbar">
              <span className="count">
                DOCUMENTS {documents.length} FILTERED {filteredDocuments.length} CHECKED {checkedDocumentIds.size} SIZE{" "}
                {formatSize(totalFilteredSizeBytes)}
              </span>
              {checkedDocumentIds.size > 0 && (
                <span className="count">
                  {hiddenCheckedCount > 0 ? `${hiddenCheckedCount} not shown by current filter` : null}
                  <button type="button" className="clear-filters" onClick={() => setCheckedDocumentIds(new Set())}>
                    Clear
                  </button>
                  <button
                    type="button"
                    className="pop-out-btn"
                    style={{ borderColor: "var(--seal)", color: "var(--seal)" }}
                    onClick={() => setShowBulkDeleteConfirm(true)}
                  >
                    Delete {checkedDocumentIds.size}
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
            </div>
            <div className="table-wrap" ref={columnWidths.containerRef}>
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
                // An explicit computed width, not just table-layout:fixed's
                // own "auto width = sum of columns" spec behavior — that
                // turned out not to reliably grow the table past 100% in
                // practice (browsers appear to treat the CSS min-width:100%
                // floor below as the effective basis and redistribute
                // column proportions to still fit it, rather than letting
                // the table actually grow). An unambiguous pixel width here
                // removes that guesswork: once the columns' real sum
                // exceeds the panel, this is bigger than 100%, and
                // .table-wrap's overflow-x:auto has something concrete to
                // scroll. min-width:100% (styles.css) still applies on top
                // of this so the table never looks narrower than the panel
                // either, if this computed value ever comes in a hair short.
                <table
                  className="reg"
                  style={{
                    width:
                      SELECT_CELL_WIDTH +
                      CHECK_CELL_WIDTH +
                      Object.values(columnWidths.widths).reduce((sum, w) => sum + w, 0),
                  }}
                >
                  <colgroup>
                    <col style={{ width: SELECT_CELL_WIDTH }} />
                    <col style={{ width: columnWidths.widths.guid }} />
                    <col style={{ width: columnWidths.widths.familyGuid }} />
                    <col style={{ width: columnWidths.widths.originalFilename }} />
                    <col style={{ width: columnWidths.widths.extension }} />
                    <col style={{ width: columnWidths.widths.sizeBytes }} />
                    <col style={{ width: columnWidths.widths.docDate }} />
                    <col style={{ width: columnWidths.widths.author }} />
                    <col style={{ width: columnWidths.widths.contentModifiedAt }} />
                    <col style={{ width: columnWidths.widths.toAddresses }} />
                    <col style={{ width: columnWidths.widths.ccAddresses }} />
                    <col style={{ width: columnWidths.widths.tags }} />
                    <col style={{ width: CHECK_CELL_WIDTH }} />
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
                      <SortableTh
                        column="guid"
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        onSort={toggleSort}
                        resizeHandle={<ColumnResizeHandle column="guid" columnWidths={columnWidths} />}
                      >
                        GUID
                      </SortableTh>
                      <SortableTh
                        column="familyGuid"
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        onSort={toggleSort}
                        resizeHandle={<ColumnResizeHandle column="familyGuid" columnWidths={columnWidths} />}
                      >
                        Family GUID
                      </SortableTh>
                      <SortableTh
                        column="originalFilename"
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        onSort={toggleSort}
                        resizeHandle={<ColumnResizeHandle column="originalFilename" columnWidths={columnWidths} />}
                      >
                        Filename
                      </SortableTh>
                      <SortableTh
                        column="extension"
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        onSort={toggleSort}
                        resizeHandle={<ColumnResizeHandle column="extension" columnWidths={columnWidths} />}
                      >
                        Type
                      </SortableTh>
                      <SortableTh
                        column="sizeBytes"
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        onSort={toggleSort}
                        resizeHandle={<ColumnResizeHandle column="sizeBytes" columnWidths={columnWidths} />}
                      >
                        Size
                      </SortableTh>
                      <SortableTh
                        column="docDate"
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        onSort={toggleSort}
                        resizeHandle={<ColumnResizeHandle column="docDate" columnWidths={columnWidths} />}
                      >
                        Date
                      </SortableTh>
                      <SortableTh
                        column="author"
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        onSort={toggleSort}
                        resizeHandle={<ColumnResizeHandle column="author" columnWidths={columnWidths} />}
                      >
                        Author
                      </SortableTh>
                      <SortableTh
                        column="contentModifiedAt"
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        onSort={toggleSort}
                        resizeHandle={<ColumnResizeHandle column="contentModifiedAt" columnWidths={columnWidths} />}
                      >
                        Date Modified
                      </SortableTh>
                      <SortableTh
                        column="toAddresses"
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        onSort={toggleSort}
                        resizeHandle={<ColumnResizeHandle column="toAddresses" columnWidths={columnWidths} />}
                      >
                        To
                      </SortableTh>
                      <SortableTh
                        column="ccAddresses"
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                        onSort={toggleSort}
                        resizeHandle={<ColumnResizeHandle column="ccAddresses" columnWidths={columnWidths} />}
                      >
                        Cc
                      </SortableTh>
                      {/* No inline position here — table.reg thead th already sets
                          position:sticky, which (like any non-static position)
                          already establishes the containing block the resize
                          handle anchors against; overriding it would break this
                          header's sticky-on-scroll behavior. */}
                      <th>
                        Tags
                        <ColumnResizeHandle column="tags" columnWidths={columnWidths} />
                      </th>
                      <th className="checkcell"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDocuments.map((doc) => {
                      const appliedTagIds = appliedTagsByDocument[doc.documentId] ?? [];
                      return (
                        <tr
                          key={doc.documentId}
                          className={doc.documentId === selectedDocumentId ? "active" : ""}
                          onClick={() => {
                            // Selects/previews the row only — does not
                            // check/uncheck it. Only the checkbox column
                            // (handleCheckboxClick) does that.
                            setSelectedDocumentId(doc.documentId);
                            // Clicking anywhere in the main window naturally
                            // gives it focus, which would drop an open
                            // pop-out behind it — hand focus straight back,
                            // including for re-selecting the row that's
                            // already selected (which wouldn't otherwise
                            // trigger the selectedDocumentId-change effect
                            // that also does this).
                            viewerWindow.focusPopout();
                          }}
                        >
                          <td className="selectcell" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={checkedDocumentIds.has(doc.documentId)}
                              // Deliberately NOT preventDefault-and-do-
                              // everything-in-onClick — that fights React's
                              // own controlled-checkbox reconciliation (the
                              // DOM's native toggle gets suppressed, but
                              // React's tracking of "did this input change"
                              // can desync from it, and the checkbox visibly
                              // stops responding to clicks at all — a real
                              // regression caught by real testing, not a
                              // guess). Instead: let the click proceed
                              // natively (onClick here only captures
                              // shiftKey, since MouseEvent.shiftKey isn't
                              // available on a checkbox's change event), and
                              // do the actual state update in onChange,
                              // which fires right after — the standard,
                              // reliable React pattern for a controlled
                              // checkbox. Also selects/previews the row like
                              // a plain row click would, with its own
                              // toggle-only-this-one check-state behavior
                              // (see handleCheckboxClick's own comment).
                              onClick={(e) => {
                                checkboxShiftKeyRef.current = e.shiftKey;
                              }}
                              onChange={() => {
                                handleCheckboxClick(doc.documentId, checkboxShiftKeyRef.current, sortedDocuments);
                                setSelectedDocumentId(doc.documentId);
                                viewerWindow.focusPopout();
                              }}
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
                            {stripExtension(displayFilename(doc), doc.extension)}
                          </td>
                          <td className="muted">{doc.extension}</td>
                          <td className="muted">{formatSize(doc.sizeBytes)}</td>
                          <td className="muted">{formatDate(doc.docDate)}</td>
                          <td className="muted">{doc.author}</td>
                          <td className="muted">{formatDate(doc.contentModifiedAt)}</td>
                          <td className="muted">{doc.toAddresses}</td>
                          <td className="muted">{doc.ccAddresses}</td>
                          <td>
                            <div className="tagchips">
                              <span
                                className="chip"
                                style={{ background: `${INGEST_STATUS_COLORS[doc.ingestStatus]}22`, color: INGEST_STATUS_COLORS[doc.ingestStatus] }}
                              >
                                {doc.ingestStatus}
                              </span>
                              {doc.contentWarning && (
                                <span className="chip" style={{ background: "#A6362C22", color: "#A6362C" }} title={doc.contentWarning}>
                                  ⚠ possible injection
                                </span>
                              )}
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
                  // "Float on top" (PiP) button removed from the UI — the
                  // underlying popOutPiP/pipSupported functionality in
                  // useViewerWindow is untouched, just unreachable from here
                  // for now, so restoring the button is a one-line revert.
                  <button type="button" className="pop-out-btn" onClick={() => viewerWindow.popOut(selectedDocument.documentId)}>
                    ⧉ Pop out
                  </button>
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
                  appliedTagsByDocument={appliedTagsByDocument}
                  tagSets={tagSets}
                  onTagsChanged={refreshTagState}
                  onPrev={goToPrev}
                  onNext={goToNext}
                  canGoPrev={selectedIndex > 0}
                  canGoNext={selectedIndex >= 0 && selectedIndex < sortedDocuments.length - 1}
                  onFocusPopout={viewerWindow.focusPopout}
                />
              </>
            )}
            {askResult && <AskResultPanel result={askResult} onSelectDocument={setSelectedDocumentId} />}
          </section>
        </main>
      )}
      {showBulkDeleteConfirm && (
        <ConfirmDialog
          title="Delete selected documents?"
          message={`Delete ${checkedDocumentIds.size} document${checkedDocumentIds.size === 1 ? "" : "s"}? Any of their own attachments will be deleted too. This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={handleBulkDelete}
          onCancel={() => setShowBulkDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
