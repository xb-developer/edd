import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, Button } from "antd";
import { ConfigProvider } from "antd";
import { StyleProvider } from "@ant-design/cssinjs";
import { antdTheme } from "./antdTheme";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { ApiClient } from "./api";
import type { DocumentDTO, TagSetDTO, AskResultDTO } from "./types";
import { DocumentViewer } from "./DocumentViewer";
import { CodingPanel } from "./CodingPanel";
import { AskResultPanel } from "./AskResultPanel";
import { FilterPanel, type IngestStatusFilter } from "./FilterPanel";
import { DocumentPropertiesPanel } from "./DocumentPropertiesPanel";
import { useViewerWindow } from "./viewer-window/useViewerWindow";
import { DocumentTable } from "./DocumentTable";
import { useDocumentDetail } from "./useDocumentDetail";
import { useDocumentImport } from "./import/useDocumentImport";
import { formatSize } from "./format";
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
  // The live size between pointerdown and pointerup. `size` state is
  // deliberately NOT updated during the drag (see onPointerMove), so this
  // ref — not the state — is the source of truth for that window.
  const liveSizeRef = useRef(initial);
  // The element actually being resized, so a move can write to it directly.
  const targetRef = useRef<HTMLElement | null>(null);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { pos: axis === "x" ? e.clientX : e.clientY, size: liveSizeRef.current };
    setDragging(true);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    const pos = axis === "x" ? e.clientX : e.clientY;
    const delta = (pos - startRef.current.pos) * direction;
    const next = Math.min(max, Math.max(min, startRef.current.size + delta));
    liveSizeRef.current = next;
    // Written straight to the element's style instead of through setState.
    // pointermove fires at the pointer's own rate (60-120Hz), and every
    // setState here re-rendered the whole of MatterDetail — including the
    // full sortedDocuments.map() and every one of its ~13 cells per row —
    // for what is only ever a single CSS length change. The useMemos around
    // the document lists don't help: the memo returns the same array, but
    // the .map() over it still re-runs and React still reconciles every
    // row. This keeps a drag O(1) regardless of how many documents are
    // loaded.
    if (targetRef.current) targetRef.current.style.flexBasis = `${next}px`;
  }
  function endDrag(e: ReactPointerEvent<HTMLDivElement>) {
    setDragging(false);
    // The one render of the whole drag — reconciling the value already
    // written to the DOM above, so there's nothing to flash.
    setSize(liveSizeRef.current);
    // A drag that never moved (a plain click) never actually captured the
    // pointer in some browsers' interpretation — releasing an uncaptured
    // pointer id throws, hence the guard.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  return {
    // During a drag, report the live ref rather than the (deliberately
    // stale) state — an unrelated re-render mid-drag would otherwise paint
    // the pre-drag size back over what was just written to the DOM.
    size: dragging ? liveSizeRef.current : size,
    dragging,
    targetRef,
    // Kept as a nested object rather than spread from the hook's own return
    // value: the call sites spread these onto the handle <div>, and `size`/
    // `dragging`/`targetRef` are not valid DOM attributes.
    handleProps: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag },
  };
}

// The drag handles between panels. The ::after pseudo-element is the small
// grab-line down the middle, expressed with Tailwind's arbitrary-variant
// syntax so the whole handle lives in one place rather than half here and
// half in a stylesheet.
const COL_RESIZE_HANDLE =
  "relative flex-[0_0_6px] cursor-col-resize bg-line-soft hover:bg-navy-soft " +
  "after:absolute after:left-0.5 after:top-1/2 after:h-7 after:w-0.5 after:-translate-y-1/2 after:rounded-sm after:bg-line after:content-['']";
const ROW_RESIZE_HANDLE =
  "relative flex-[0_0_6px] cursor-row-resize bg-line-soft hover:bg-navy-soft " +
  "after:absolute after:left-1/2 after:top-0.5 after:h-0.5 after:w-7 after:-translate-x-1/2 after:rounded-sm after:bg-line after:content-['']";

export function MatterDetail({ api, matterId, canManageAccess, currentUserId, matterCreatedBy }: MatterDetailProps) {
  // Updated on every render (not via its own effect) so it's already the
  // NEW matterId by the time any in-flight request for the OLD matterId
  // resolves — see refreshDocuments/refreshTagState below, which compare
  // against this to drop a stale response instead of applying it.
  const currentMatterIdRef = useRef(matterId);
  currentMatterIdRef.current = matterId;
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
  // "Checked" (ticked/unticked) — distinct from "selected" (previewed; see
  // selectedDocumentId). Not pruned when a search/tag filter hides a row;
  // see the toolbar's visible/hidden count split below. Only the checkbox
  // column (handleCheckboxClick) drives this — a plain row click
  // selects/previews the document without checking/unchecking it.
  const [checkedDocumentIds, setCheckedDocumentIds] = useState<Set<string>>(new Set());
  // The last plain (non-shift) checkbox click that set the selection
  // anchor — what a subsequent shift-click ranges *from*. Deliberately
  // doesn't move on a shift-click itself (standard file-manager convention:
  // click 3, shift-click 7 selects 3-7; a further shift-click 1 selects
  // 1-3, ranging from the original anchor at 3, not from 7) — repeated
  // shift-clicks stay anchored to the same starting row until the next
  // plain click.
  const [checkboxAnchorId, setCheckboxAnchorId] = useState<string | null>(null);
  function toggleChecked(documentId: string) {
    setCheckedDocumentIds((prev) => {
      const next = new Set(prev);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  }

  // Shared shift-click range logic for checkbox clicks: everything between
  // the anchor and the clicked row (inclusive, in current sorted/visible row
  // order) gets checked — anything already checked outside that range stays
  // checked, matching the standard OS file-manager convention. Returns
  // false (meaning: no live anchor to range from — first-ever click, or the
  // anchor row got filtered/sorted out) so the caller can fall back to its
  // own non-shift-click behavior instead.
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

  // The checkbox column is the only thing that checks/unchecks a document —
  // a plain row click (see the row's own onClick) only selects/previews it,
  // never touches checked state. A plain checkbox click toggles just this
  // one row's *checked* state (add or remove), leaving every other checked
  // row alone. Shift range-extends from the last plain-clicked checkbox,
  // same file-manager convention as a shift-click anywhere else.
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

  function refreshDocuments() {
    // Guards against an out-of-order response: switching matters (e.g. via
    // Create Matter) fires a new request for the new matterId while an
    // older, slower request for the PREVIOUS matter may still be in
    // flight — a brand-new empty matter's query is trivially fast and can
    // resolve before a large matter's does, so without this check the
    // stale response lands last and silently overwrites the correct
    // (empty) document list with the old matter's documents.
    const requestedMatterId = matterId;
    api
      .getMatterDocuments(matterId)
      .then((docs) => {
        if (currentMatterIdRef.current === requestedMatterId) setDocuments(docs);
      })
      .catch((err) => {
        if (currentMatterIdRef.current === requestedMatterId) setError(err.message);
      });
  }

  useEffect(refreshDocuments, [matterId]);

  // A stale search query from the previous matter has no meaning here —
  // clear it the moment the open matter changes, same as FilterPanel's own
  // question-clearing effect for Ask. The debounced search effect below
  // reacts to this (trimmed empty -> clears matchingDocumentIds/
  // searchTotalHits/searchError too), so nothing else needs resetting here.
  useEffect(() => {
    setSearchQuery("");
  }, [matterId]);

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
    // Same stale-response guard as refreshDocuments above — a matter
    // switch can leave a slower previous-matter request in flight.
    const requestedMatterId = matterId;
    api
      .getTagSets(matterId)
      .then((sets) => {
        if (currentMatterIdRef.current === requestedMatterId) setTagSets(sets);
      })
      .catch((err) => {
        if (currentMatterIdRef.current === requestedMatterId) setError(err.message);
      });
    api
      .getAllDocumentTags(matterId)
      .then((tags) => {
        if (currentMatterIdRef.current === requestedMatterId) setAppliedTagsByDocument(tags);
      })
      .catch((err) => {
        if (currentMatterIdRef.current === requestedMatterId) setError(err.message);
      });
  }

  useEffect(refreshTagState, [matterId]);

  // Memoized on tagSets, not rebuilt per render — this is a flatMap plus a
  // Map build over every tag in the matter, and it ran on every pointermove
  // during a panel/column drag (see useDragResize/useColumnWidths) purely
  // because some unrelated piece of state changed.
  const tagsById = useMemo(() => new Map(tagSets.flatMap((tagSet) => tagSet.tags).map((tag) => [tag.id, tag])), [tagSets]);

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

  // Memoized — without this, every render (a search keystroke before the
  // debounce even fires, a checkbox click, an ingest-poll tick 3s apart)
  // re-ran a full filter/sort pass over the whole document list, even
  // though most renders touch state this computation doesn't depend on at
  // all.
  const filteredDocuments = useMemo(
    () =>
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
      }) ?? null,
    [documents, matchingDocumentIds, askRelevantDocumentIds, statusFilter, selectedTagIds, appliedTagsByDocument, tagMatchMode],
  );

  const visibleCheckedCount = filteredDocuments?.filter((d) => checkedDocumentIds.has(d.documentId)).length ?? 0;
  const hiddenCheckedCount = checkedDocumentIds.size - visibleCheckedCount;
  // Sum over the FILTERED set (the current working view), not the whole
  // matter — matches what "FILTERED" already narrows the table to.
  const totalFilteredSizeBytes = filteredDocuments?.reduce((sum, d) => sum + d.sizeBytes, 0) ?? 0;

  // Same elements as filteredDocuments, just reordered — used for
  // everything render/navigation-facing below so Prev/Next and the table's
  // own row order both match whatever the reviewer actually sees after a
  // column-header sort, not the underlying filtered-but-unsorted order.
  // Memoized for the same reason filteredDocuments is — sorting is the
  // more expensive of the two passes.
  const sortedDocuments = useMemo(
    () => (filteredDocuments && sortColumn ? sortDocuments(filteredDocuments, sortColumn, sortDirection) : filteredDocuments),
    [filteredDocuments, sortColumn, sortDirection],
  );

  const selectedListDocument = sortedDocuments?.find((d) => d.documentId === selectedDocumentId) ?? null;
  // The list row carries everything except `metadata` (the server omits
  // it from list responses now); this fills that one field in on demand,
  // cached, and falls back to the list row while the fetch is in flight.
  const selectedDocument = useDocumentDetail(api, matterId, selectedListDocument);
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
        <div className="pointer-events-none fixed inset-0 z-[1000] flex items-center justify-center bg-[rgba(23,42,71,0.85)] text-xl font-semibold text-white">
          <span>Drop files to import</span>
        </div>
      )}
      {error && (
        <div className="max-h-40 overflow-y-auto border-b border-[#e6c3be] bg-seal-soft px-5 py-2.5">
          <div className="flex items-center justify-between gap-3.5">
            <span>{error}</span>
            <Button type="text" size="small" onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </Button>
          </div>
        </div>
      )}

      {documentImport.importProgress && (
        <div className="flex items-center gap-3.5 border-b border-[#ead6a5] bg-amber-soft px-5 py-2">
          <span className="flex-none whitespace-nowrap text-[11.5px] font-semibold text-[#6b4c05]">
            Importing document {documentImport.importProgress.current} of {documentImport.importProgress.total}
            {documentImport.importProgress.errors > 0 ? ` — ${documentImport.importProgress.errors} failed` : ""}
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-[3px] border border-[#ead6a5] bg-white">
            <div
              className="h-full bg-seal transition-[width] duration-200 ease-out"
              style={{ width: `${(documentImport.importProgress.current / documentImport.importProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {documentImport.ingestProgress && (
        <div className="flex items-center gap-3.5 border-b border-[#ead6a5] bg-amber-soft px-5 py-2">
          <span className="flex-none whitespace-nowrap text-[11.5px] font-semibold text-[#6b4c05]">
            {documentImport.ingestProgress.gaveUp
              ? `${documentImport.ingestProgress.remaining} document${documentImport.ingestProgress.remaining === 1 ? "" : "s"} still processing — reload to check`
              : `Processing ${documentImport.ingestProgress.total - documentImport.ingestProgress.remaining} of ${documentImport.ingestProgress.total} document${documentImport.ingestProgress.total === 1 ? "" : "s"}…`}
            {documentImport.ingestProgress.failed > 0 ? ` — ${documentImport.ingestProgress.failed} failed` : ""}
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-[3px] border border-[#ead6a5] bg-white">
            <div
              className="h-full bg-seal transition-[width] duration-200 ease-out"
              style={{
                width: `${((documentImport.ingestProgress.total - documentImport.ingestProgress.remaining) / documentImport.ingestProgress.total) * 100}%`,
              }}
            />
          </div>
          {(documentImport.ingestProgress.gaveUp || documentImport.ingestProgress.failed > 0) && (
            <Button type="text" size="small" onClick={documentImport.dismissIngestProgress} aria-label="Dismiss">
              ×
            </Button>
          )}
        </div>
      )}

      {documentImport.importFailures && (
        <div className="max-h-40 overflow-y-auto border-b border-[#e6c3be] bg-seal-soft px-5 py-2.5">
          <div className="flex items-center justify-between gap-3.5">
            <span>
              {documentImport.importFailures.length} file{documentImport.importFailures.length === 1 ? "" : "s"} failed to import
            </span>
            <Button type="text" size="small" onClick={documentImport.dismissFailures} aria-label="Dismiss">
              ×
            </Button>
          </div>
          <ul className="m-0 mt-2 list-none p-0 text-[11.5px] leading-[1.7] [&_li]:truncate">
            {documentImport.importFailures.map((failure, i) => (
              <li key={i}>
                <span className="fname">{failure.filename}</span> <span className="text-ink-soft">— {failure.error}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!documents || !filteredDocuments || !sortedDocuments ? (
        <p className="px-0.5 py-1 text-[11.5px] italic text-ink-soft" style={{ padding: 16 }}>
          Loading…
        </p>
      ) : (
        <main className="flex min-h-0 flex-1">
          <FilterPanel
            api={api}
            matterId={matterId}
            canManageAccess={canManageAccess}
            currentUserId={currentUserId}
            matterCreatedBy={matterCreatedBy}
            style={{ flexBasis: leftResize.size }}
            rootRef={leftResize.targetRef}
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
            selectedDocumentIds={checkedDocumentIds}
            documents={documents}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            onDocumentsChanged={refreshDocuments}
            onAskResult={handleAskResult}
          />

          <div className={`${COL_RESIZE_HANDLE}${leftResize.dragging ? " bg-navy-soft" : ""}`} {...leftResize.handleProps} />

          <section className="flex min-w-[200px] flex-[1_1_0] flex-col overflow-hidden">
            <div className="flex items-center gap-2.5 border-b border-line bg-panel px-4 py-2.5">
              <span className="font-mono text-[11.5px] text-ink-soft">
                DOCUMENTS {documents.length} FILTERED {filteredDocuments.length} CHECKED {checkedDocumentIds.size} SIZE{" "}
                {formatSize(totalFilteredSizeBytes)}
              </span>
              {checkedDocumentIds.size > 0 && (
                <span className="font-mono text-[11.5px] text-ink-soft">
                  {hiddenCheckedCount > 0 ? `${hiddenCheckedCount} not shown by current filter` : null}
                  <Button type="text" size="small" onClick={() => setCheckedDocumentIds(new Set())}>
                    Clear
                  </Button>
                  {/* `danger` replaces the inline --seal border/colour: antd
                      derives it from colorError, which antdTheme.ts maps to
                      that same token. */}
                  <Button danger type="primary" size="small" onClick={() => setShowBulkDeleteConfirm(true)}>
                    Delete {checkedDocumentIds.size}
                  </Button>
                </span>
              )}
              {/* The label still carries the live n/total count, which
                  `loading` alone can't express — so this one keeps its
                  label swap and gets the spinner as well. */}
              <Button type="primary" size="small" loading={documentImport.importing} onClick={() => fileInputRef.current?.click()}>
                {documentImport.importProgress
                  ? `Importing ${documentImport.importProgress.current}/${documentImport.importProgress.total}…`
                  : "+ Import documents"}
              </Button>
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
            <DocumentTable
              matterId={matterId}
              documents={sortedDocuments}
              filteredDocuments={filteredDocuments}
              selectedDocumentId={selectedDocumentId}
              checkedDocumentIds={checkedDocumentIds}
              appliedTagsByDocument={appliedTagsByDocument}
              tagsById={tagsById}
              sortColumn={sortColumn}
              sortDirection={sortDirection}
              onSort={toggleSort}
              onSelect={(documentId) => {
                // "Selected" = previewed in the right-hand pane. Clicking
                // anywhere on the row except the checkbox selects it;
                // checked/unchecked state is untouched by this.
                setSelectedDocumentId(documentId);
                // Clicking anywhere in the main window naturally gives it
                // focus, which would drop an open pop-out behind it — hand
                // focus straight back, including when re-selecting the row
                // that is already selected (which wouldn't otherwise
                // trigger the selectedDocumentId-change effect that also
                // does this).
                viewerWindow.focusPopout();
              }}
              onToggleChecked={(documentId, shiftKey) => {
                handleCheckboxClick(documentId, shiftKey, sortedDocuments);
                viewerWindow.focusPopout();
              }}
              onToggleSelectAll={() => toggleSelectAllVisible(filteredDocuments)}
              onDelete={handleDeleteDocument}
              emptyState={
                <div className="flex h-full w-full flex-col items-center justify-center p-10 text-center text-ink-soft">
                  <div className="mb-2.5 font-mono text-[34px] text-line">000000</div>
                  <h3 className="m-0 mb-1.5 text-sm text-ink">
                    {documents.length === 0 ? "No documents yet." : "No documents match the current filters."}
                  </h3>
                  <p className="m-0 mb-3.5 max-w-[280px] text-xs leading-relaxed">
                    {documents.length === 0
                      ? "Documents uploaded to this matter will appear here once ingested."
                      : "Try clearing the search or tag filter."}
                  </p>
                </div>
              }
            />
          </section>

          <div className={`${COL_RESIZE_HANDLE}${rightResize.dragging ? " bg-navy-soft" : ""}`} {...rightResize.handleProps} />

          <section className="flex min-h-0 flex-[0_0_auto] flex-col overflow-hidden border-l border-line bg-panel" style={{ flexBasis: rightResize.size }} ref={rightResize.targetRef as React.RefObject<HTMLElement>}>
            {selectedDocument && (
              <div className="flex flex-none items-center justify-between gap-2 border-b border-line bg-panel px-4 pt-2.5 pb-[9px]">
                <h2 className="m-0 mb-2.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-soft uppercase">Preview</h2>
                {viewerWindow.state === "docked" ? (
                  // "Float on top" (PiP) button removed from the UI — the
                  // underlying popOutPiP/pipSupported functionality in
                  // useViewerWindow is untouched, just unreachable from here
                  // for now, so restoring the button is a one-line revert.
                  <Button size="small" onClick={() => viewerWindow.popOut(selectedDocument.documentId)}>
                    ⧉ Pop out
                  </Button>
                ) : (
                  <Button size="small" onClick={viewerWindow.dockBack}>
                    Dock back
                  </Button>
                )}
              </div>
            )}
            {viewerWindow.popOutError && <Alert type="warning" showIcon className="mb-2" message={viewerWindow.popOutError} />}
            <div className="min-h-0 flex-1 overflow-y-auto p-4" style={{ flexBasis: rowResize.size, flexGrow: 0, flexShrink: 0 }} ref={rowResize.targetRef as React.RefObject<HTMLDivElement>}>
              {!selectedDocument ? (
                <p className="p-4 text-center text-xs italic text-ink-soft">Select a document to preview it.</p>
              ) : viewerWindow.state === "open" ? (
                <>
                  <DocumentPropertiesPanel document={selectedDocument} />
                  <p className="p-4 text-center text-xs italic text-ink-soft">Viewer opened in a separate window.</p>
                </>
              ) : viewerWindow.state === "pip" ? (
                <>
                  <DocumentPropertiesPanel document={selectedDocument} />
                  <p className="p-4 text-center text-xs italic text-ink-soft">Viewer floating in picture-in-picture.</p>
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
                // StyleProvider + ConfigProvider, even though this is the
                // SAME React tree and realm as the main window: antd
                // injects each component's CSS-in-JS into the document its
                // provider points at, lazily, the first time that component
                // renders. Without redirecting it at the PiP document, those
                // rules land in the OPENER's head and the PiP viewer renders
                // unstyled. copyStylesInto (useViewerWindow.ts) only copies
                // what already exists at open time, so it can't cover this.
                <StyleProvider container={viewerWindow.pipContainer.ownerDocument.head}>
                  <ConfigProvider theme={antdTheme} getPopupContainer={() => viewerWindow.pipContainer!}>
                    {/* The column the preview stretches inside — in the
                        docked pane this came from the panel-body wrapper,
                        which the PiP tree doesn't render. */}
                    <div className="flex min-h-0 flex-1 flex-col">
                      <DocumentPropertiesPanel document={selectedDocument} />
                      <DocumentViewer api={api} matterId={matterId} document={selectedDocument} />
                    </div>
                  </ConfigProvider>
                </StyleProvider>,
                viewerWindow.pipContainer,
              )}
            {selectedDocument && (
              <>
                <div className={`${ROW_RESIZE_HANDLE}${rowResize.dragging ? " bg-navy-soft" : ""}`} {...rowResize.handleProps} />
                <CodingPanel
                  api={api}
                  matterId={matterId}
                  documentId={selectedDocument.documentId}
                  bulkSelectedDocumentIds={checkedDocumentIds}
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
