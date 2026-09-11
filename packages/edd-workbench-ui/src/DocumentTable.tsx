import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Checkbox, Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { DocumentDTO, TagDTO } from "./types";
import { formatSize, formatDate, displayFilename, stripExtension } from "./format";
import type { SortableColumn, SortDirection } from "./sortDocuments";

const INGEST_STATUS_COLORS: Record<DocumentDTO["ingestStatus"], string> = {
  pending: "#5B6272",
  processing: "#B4780C",
  ready: "#1F2A44",
  failed: "#A6362C",
};

export type DocumentColumnKey =
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
// fitToContainer), not a fixed preference.
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
const SELECT_CELL_WIDTH = 32;
const CHECK_CELL_WIDTH = 32;
const ROW_HEIGHT = 34;

const DEFAULT_COLUMN_WIDTHS: Record<DocumentColumnKey, number> = { ...PREFERRED_COLUMN_WIDTHS, originalFilename: 220 };

/**
 * Column drag-to-resize, kept hand-rolled on purpose: antd's Table has no
 * built-in column resizing (its own docs demonstrate it with an external
 * library), and this app already had working Pointer Capture mechanics
 * whose behaviour is understood.
 *
 * `setPointerCapture` keeps delivering move events once the pointer leaves
 * the handle, so a fast drag past the element's bounds doesn't drop the
 * interaction the way mouseenter/mouseleave would.
 *
 * Also owns "fit the columns to the panel's actual width" — every other
 * column keeps its preferred width and filename absorbs the remainder, so
 * the table needs no horizontal scrollbar on a fresh load at any screen
 * size. That auto-fit re-runs when the matter changes or the panel is
 * resized, but ONLY until the user drags a column themselves, at which
 * point their explicit choice wins and a scrollbar is the expected result
 * rather than something to silently fight.
 */
function useColumnWidths(matterId: string) {
  const [widths, setWidths] = useState<Record<DocumentColumnKey, number>>(DEFAULT_COLUMN_WIDTHS);
  const [draggingColumn, setDraggingColumn] = useState<DocumentColumnKey | null>(null);
  const dragRef = useRef({ column: null as DocumentColumnKey | null, startX: 0, startWidth: 0 });
  const manuallyResizedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The live widths between pointerdown and pointerup. `widths` state is
  // deliberately NOT updated during a drag — see onMove — so this ref, not
  // the state, is the source of truth for that window.
  const liveWidthsRef = useRef<Record<DocumentColumnKey, number>>(DEFAULT_COLUMN_WIDTHS);

  const applyWidths = useCallback((next: Record<DocumentColumnKey, number>) => {
    liveWidthsRef.current = next;
    setWidths(next);
  }, []);

  const fitToContainer = useCallback(() => {
    if (manuallyResizedRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const preferredTotal = Object.values(PREFERRED_COLUMN_WIDTHS).reduce((sum, w) => sum + w, 0);
    // -2px slack against border/rounding, so fitting exactly never itself
    // produces a 1px scrollbar sliver.
    const available = container.clientWidth - SELECT_CELL_WIDTH - CHECK_CELL_WIDTH - preferredTotal - 2;
    applyWidths({ ...PREFERRED_COLUMN_WIDTHS, originalFilename: Math.max(MIN_COLUMN_WIDTH, available) });
  }, [applyWidths]);

  // Layout effect, not a plain effect — this measures and sets widths that
  // affect visible layout immediately; running before the browser's first
  // paint of the new matter avoids a flash of the previous widths.
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

  const startResize = useCallback(
    (column: DocumentColumnKey) => (e: ReactPointerEvent<HTMLElement>) => {
      // Otherwise a plain click-without-drag on the handle bubbles up and
      // toggles the column's sort.
      e.stopPropagation();
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      manuallyResizedRef.current = true;
      dragRef.current = { column, startX: e.clientX, startWidth: liveWidthsRef.current[column] };
      setDraggingColumn(column);
    },
    [],
  );

  const onMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag.column) return;
    const next = Math.max(MIN_COLUMN_WIDTH, drag.startWidth + (e.clientX - drag.startX));
    liveWidthsRef.current = { ...liveWidthsRef.current, [drag.column]: next };
    // Written straight to rc-table's own <colgroup>, not through setState.
    // pointermove fires at the pointer's own rate (60-120Hz); a setState per
    // move re-renders the whole table on every one of them. Committed to
    // state once, on release.
    const container = containerRef.current;
    if (!container) return;
    for (const colgroup of Array.from(container.querySelectorAll("colgroup"))) {
      const col = colgroup.querySelectorAll("col")[COLUMN_ORDER.indexOf(drag.column) + 1];
      if (col instanceof HTMLTableColElement) col.style.width = `${next}px`;
    }
  }, []);

  const endResize = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current.column) return;
    dragRef.current.column = null;
    setDraggingColumn(null);
    // The one render of the whole drag.
    setWidths(liveWidthsRef.current);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  return { widths, draggingColumn, startResize, onMove, endResize, containerRef };
}

// The visual left-to-right order, used both to build the columns array and
// to map a dragged column back to its <col> index (offset by one for the
// leading checkbox column).
const COLUMN_ORDER: DocumentColumnKey[] = [
  "guid",
  "familyGuid",
  "originalFilename",
  "extension",
  "sizeBytes",
  "docDate",
  "author",
  "contentModifiedAt",
  "toAddresses",
  "ccAddresses",
  "tags",
];

const COLUMN_TITLES: Record<DocumentColumnKey, string> = {
  guid: "GUID",
  familyGuid: "Family GUID",
  originalFilename: "Filename",
  extension: "Type",
  sizeBytes: "Size",
  docDate: "Date",
  author: "Author",
  contentModifiedAt: "Date Modified",
  toAddresses: "To",
  ccAddresses: "Cc",
  tags: "Tags",
};

// Tags is the one column with nothing meaningful to sort on — it renders a
// set of chips, not a scalar.
const SORTABLE_COLUMNS = new Set<DocumentColumnKey>(COLUMN_ORDER.filter((c) => c !== "tags"));

export interface DocumentTableProps {
  matterId: string;
  /** Already sorted by the caller — see the `sorter: true` note in the columns below. */
  documents: DocumentDTO[];
  /** The caller's pre-filter list, which "select all" and its indeterminate state are computed against — NOT the sorted/visible rows. */
  filteredDocuments: DocumentDTO[];
  selectedDocumentId: string | null;
  checkedDocumentIds: ReadonlySet<string>;
  appliedTagsByDocument: Record<string, string[]>;
  tagsById: Map<string, TagDTO>;
  sortColumn: SortableColumn | null;
  sortDirection: SortDirection;
  onSort: (column: SortableColumn) => void;
  onSelect: (documentId: string) => void;
  onToggleChecked: (documentId: string, shiftKey: boolean) => void;
  onToggleSelectAll: () => void;
  onDelete: (doc: DocumentDTO) => void;
  /** Rendered in place of rows when there are none — distinguishes "no documents in this matter" from "none match the filters", which only the caller knows. */
  emptyState: ReactNode;
}

/**
 * The matter's document table.
 *
 * Virtualised (antd's `virtual`), which is the reason it's an antd Table at
 * all: the hand-built table rendered every row of the matter, ~18-20 DOM
 * nodes each, so 10,000 documents was ~190,000 nodes with no windowing.
 *
 * Two things are deliberately NOT delegated to antd:
 *
 *  - Row selection. antd's `rowSelection` has no shift-click range select,
 *    and the exact checked/selected semantics here were specified
 *    carefully (clicking a row previews it; clicking the checkbox toggles
 *    its checked state AND previews it; shift extends a range). A plain
 *    checkbox column keeps that behaviour exactly rather than approximating
 *    it.
 *  - Sorting. `sorter: true` tells antd the data is sorted externally, so
 *    it renders the sort UI and reports clicks without reordering anything
 *    itself. sortDocuments.ts keeps owning the actual comparison, including
 *    its null handling and its skip-localeCompare fast path.
 */
export function DocumentTable({
  matterId,
  documents,
  filteredDocuments,
  selectedDocumentId,
  checkedDocumentIds,
  appliedTagsByDocument,
  tagsById,
  sortColumn,
  sortDirection,
  onSort,
  onSelect,
  onToggleChecked,
  onToggleSelectAll,
  onDelete,
  emptyState,
}: DocumentTableProps) {
  const columnWidths = useColumnWidths(matterId);
  const [bodyHeight, setBodyHeight] = useState(400);

  // antd's virtual mode needs a concrete pixel height for the scroll body —
  // it can't window against a flex-grown container on its own.
  useEffect(() => {
    const container = columnWidths.containerRef.current;
    if (!container) return;
    const measure = () => setBodyHeight(Math.max(ROW_HEIGHT * 2, container.clientHeight - ROW_HEIGHT));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [columnWidths.containerRef]);

  const allChecked = filteredDocuments.length > 0 && filteredDocuments.every((d) => checkedDocumentIds.has(d.documentId));
  const anyChecked = filteredDocuments.some((d) => checkedDocumentIds.has(d.documentId));

  // MouseEvent.shiftKey isn't available on a checkbox's change event, so
  // it's captured from the click that immediately precedes it.
  const shiftKeyRef = useRef(false);

  const columns = useMemo<ColumnsType<DocumentDTO>>(() => {
    const checkboxColumn = {
      key: "__select",
      width: SELECT_CELL_WIDTH,
      fixed: "left" as const,
      // The one cell with no padding — it holds only a checkbox. Reaching
      // an antd cell's own padding needs a selector, so this is a hook for
      // the rule in styles.css, not a Tailwind class.
      className: "selectcell",
      title: (
        <Checkbox
          checked={allChecked}
          indeterminate={anyChecked && !allChecked}
          onChange={onToggleSelectAll}
          aria-label="Select all"
        />
      ),
      render: (_: unknown, doc: DocumentDTO) => (
        <Checkbox
          checked={checkedDocumentIds.has(doc.documentId)}
          onClick={(e) => {
            shiftKeyRef.current = e.shiftKey;
            // The row's own onClick would otherwise also fire and re-select,
            // which is harmless but does duplicate work.
            e.stopPropagation();
          }}
          onChange={() => {
            onToggleChecked(doc.documentId, shiftKeyRef.current);
            onSelect(doc.documentId);
          }}
          aria-label={`Select ${doc.originalFilename}`}
        />
      ),
    };

    const dataColumns = COLUMN_ORDER.map((key) => ({
      key,
      dataIndex: key,
      title: COLUMN_TITLES[key],
      width: columnWidths.widths[key],
      ellipsis: true,
      // Sorting is external — see this component's own doc comment.
      sorter: SORTABLE_COLUMNS.has(key) || undefined,
      sortOrder: sortColumn === key ? (sortDirection === "asc" ? ("ascend" as const) : ("descend" as const)) : null,
      onHeaderCell: () => ({ "data-column-key": key }),
      render: (_: unknown, doc: DocumentDTO) => renderCell(key, doc, appliedTagsByDocument, tagsById),
    }));

    const deleteColumn = {
      key: "__delete",
      width: CHECK_CELL_WIDTH,
      fixed: "right" as const,
      title: "",
      render: (_: unknown, doc: DocumentDTO) => (
        <button
          type="button"
          className="cursor-pointer border-0 bg-transparent px-1 text-base leading-none text-ink-soft hover:text-seal"
          aria-label={`Delete ${doc.originalFilename}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(doc);
          }}
        >
          ×
        </button>
      ),
    };

    return [checkboxColumn, ...dataColumns, deleteColumn] as ColumnsType<DocumentDTO>;
  }, [
    allChecked,
    anyChecked,
    checkedDocumentIds,
    columnWidths.widths,
    sortColumn,
    sortDirection,
    appliedTagsByDocument,
    tagsById,
    onToggleSelectAll,
    onToggleChecked,
    onSelect,
    onDelete,
  ]);

  const totalWidth = SELECT_CELL_WIDTH + CHECK_CELL_WIDTH + Object.values(columnWidths.widths).reduce((sum, w) => sum + w, 0);

  return (
    <div className="relative min-h-0 w-full min-w-0 flex-1 overflow-hidden" ref={columnWidths.containerRef}>
      <Table<DocumentDTO>
        virtual
        size="small"
        rowKey="documentId"
        columns={columns}
        dataSource={documents}
        pagination={false}
        scroll={{ x: totalWidth, y: bodyHeight }}
        showSorterTooltip={false}
        locale={{ emptyText: emptyState }}
        rowClassName={(doc) => (doc.documentId === selectedDocumentId ? "active" : "")}
        onRow={(doc) => ({
          onClick: () => onSelect(doc.documentId),
        })}
        onChange={(_pagination, _filters, sorter) => {
          const field = Array.isArray(sorter) ? sorter[0]?.columnKey : sorter.columnKey;
          if (typeof field === "string") onSort(field as SortableColumn);
        }}
        components={{
          header: {
            cell: (props: Record<string, unknown> & { children?: ReactNode }) => {
              const columnKey = props["data-column-key"] as DocumentColumnKey | undefined;
              const { children, ...rest } = props;
              return (
                <th {...rest} className={`${(rest.className as string) ?? ""} relative`}>
                  {children}
                  {columnKey && (
                    <span
                      className={`col-resize-th-handle${columnWidths.draggingColumn === columnKey ? " dragging" : ""}`}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={columnWidths.startResize(columnKey)}
                      onPointerMove={columnWidths.onMove}
                      onPointerUp={columnWidths.endResize}
                      onPointerCancel={columnWidths.endResize}
                    />
                  )}
                </th>
              );
            },
          },
        }}
      />
    </div>
  );
}

function renderCell(
  key: DocumentColumnKey,
  doc: DocumentDTO,
  appliedTagsByDocument: Record<string, string[]>,
  tagsById: Map<string, TagDTO>,
): ReactNode {
  switch (key) {
    case "guid":
      return <span className="font-mono font-semibold tracking-[0.02em] text-navy">{doc.guid}</span>;
    case "familyGuid":
      return <span className="text-ink-soft">{doc.familyGuid}</span>;
    case "originalFilename":
      return (
        <span
          className="fname"
          title={doc.depth > 0 ? `Attached to ${doc.parentGuid}` : doc.originalFilename}
          // Indentation is per-row data, not a style rule — it can't move to
          // a Tailwind class.
          style={doc.depth > 0 ? { paddingLeft: doc.depth * 16 } : undefined}
        >
          {doc.depth > 0 && <span className="text-ink-soft">↳ </span>}
          {stripExtension(displayFilename(doc), doc.extension)}
        </span>
      );
    case "extension":
      return <span className="text-ink-soft">{doc.extension}</span>;
    case "sizeBytes":
      return <span className="text-ink-soft">{formatSize(doc.sizeBytes)}</span>;
    case "docDate":
      return <span className="text-ink-soft">{formatDate(doc.docDate)}</span>;
    case "author":
      return <span className="text-ink-soft">{doc.author}</span>;
    case "contentModifiedAt":
      return <span className="text-ink-soft">{formatDate(doc.contentModifiedAt)}</span>;
    case "toAddresses":
      return <span className="text-ink-soft">{doc.toAddresses}</span>;
    case "ccAddresses":
      return <span className="text-ink-soft">{doc.ccAddresses}</span>;
    case "tags":
      return <TagChips doc={doc} appliedTagsByDocument={appliedTagsByDocument} tagsById={tagsById} />;
  }
}

function TagChips({
  doc,
  appliedTagsByDocument,
  tagsById,
}: {
  doc: DocumentDTO;
  appliedTagsByDocument: Record<string, string[]>;
  tagsById: Map<string, TagDTO>;
}) {
  const appliedTagIds = appliedTagsByDocument[doc.documentId] ?? [];
  return (
    <div className="flex h-row max-w-[220px] flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden">
      {/* Chip colours are data (an ingest status, or a tag's own colour from
          the database), so they stay inline — there is no finite set of
          Tailwind classes that could cover them. */}
      <span
        className="flex-none whitespace-nowrap rounded-[9px] px-[7px] py-0.5 text-xs font-semibold"
        style={{ background: `${INGEST_STATUS_COLORS[doc.ingestStatus]}22`, color: INGEST_STATUS_COLORS[doc.ingestStatus] }}
      >
        {doc.ingestStatus}
      </span>
      {doc.contentWarning && (
        <span className="flex-none whitespace-nowrap rounded-[9px] px-[7px] py-0.5 text-xs font-semibold" style={{ background: "#A6362C22", color: "#A6362C" }} title={doc.contentWarning}>
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
          <span key={tagId} className="flex-none whitespace-nowrap rounded-[9px] px-[7px] py-0.5 text-xs font-semibold" style={style}>
            {tag.name}
          </span>
        );
      })}
    </div>
  );
}
