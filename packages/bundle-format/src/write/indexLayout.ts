import type { BundleStructureNode } from "../types.js";
import type { PlanBundle, PlanTab } from "./assembleStructure.js";
import { computeDocNumbers } from "./docNumbering.js";
import { measureText } from "./textWidth.js";

export interface IndexTabRow {
  kind: "tabHeader";
  label: string;
  /** 0 for a tab directly under the bundle set, 1 for a sub-tab nested inside that tab, and so on — lets the renderer indent nested tab headers so they read as nested rather than as unrelated siblings at the same level. */
  depth: number;
}
export interface IndexDocRow {
  kind: "doc";
  order: number;
  documentLines: string[];
  date: string | null;
  /** "" during the counting pass (unused for layout — see indexLayout.ts's rowHeight), real text during the final pass. */
  pageRange: string;
  /** 0-based absolute page index of the document's first page — the row's link target. 0/unused during the counting pass. */
  targetPage: number;
}
export type IndexRow = IndexTabRow | IndexDocRow;

export interface IndexLayoutConfig {
  pageWidth: number;
  pageHeight: number;
  marginX: number;
  rowHeight: number;
  wrapLineHeight: number;
  columns: { order: number; document: number; date: number; pages: number; right: number };
  /** Font size document-name lines are drawn at — kept here (not just in indexRender.ts's drawText call) so wrap-width measurement always matches what's actually rendered. */
  docFontSize: number;
  /** Vertical space available for table rows on the page carrying the case heading (page 1). */
  firstPageRowsBudget: number;
  /** Vertical space available for table rows on continuation pages. */
  continuationRowsBudget: number;
}

/**
 * Matches a real court bundle's own Index page (a High Court / Business &
 * Property Courts style index: case heading, then an Order/Document/Date/
 * Pages table with a shaded row per tab) — measured directly off a real
 * page's text coordinates in Stratum's build history, not invented.
 */
export const COURT_INDEX_LAYOUT: IndexLayoutConfig = {
  pageWidth: 595.28,
  pageHeight: 841.89,
  marginX: 40,
  rowHeight: 20,
  wrapLineHeight: 12,
  columns: { order: 40, document: 119, date: 329, pages: 461, right: 556 },
  docFontSize: 9.5,
  firstPageRowsBudget: 427,
  continuationRowsBudget: 715,
};

/** How far into `word` fits within `maxWidth` at `size` — used to hard-break a single unbroken token (e.g. an underscored filename) that's wider than a whole line by itself. */
function fitLength(word: string, maxWidth: number, size: number): number {
  let len = word.length;
  while (len > 1 && measureText(word.slice(0, len), size) > maxWidth) len--;
  return len;
}

/**
 * Wraps a document name to fit the Index's Document column, measured by real
 * glyph width rather than character count (see textWidth.ts for why).
 */
function wrapDocumentName(name: string, maxWidth: number, size: number): string[] {
  const words = name.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const rawWord of words) {
    let word = rawWord;
    while (measureText(word, size) > maxWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }
      const breakAt = fitLength(word, maxWidth, size);
      lines.push(word.slice(0, breakAt));
      word = word.slice(breakAt);
    }
    const test = current ? `${current} ${word}` : word;
    if (current && measureText(test, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Bundle sets with no letter (a flat, single-set bundle) render bare page numbers, matching that bundle's own convention — no stray leading separator. */
function pageRangeFor(bundleLabel: string, startRel: number, endRel: number): string {
  const start = bundleLabel ? `${bundleLabel}-${startRel}` : String(startRel);
  const end = bundleLabel ? `${bundleLabel}-${endRel}` : String(endRel);
  return startRel === endRel ? start : `${start} - ${end}`;
}

function docColumnMaxWidth(config: IndexLayoutConfig): number {
  // 4pt left padding (matches indexRender.ts's drawText x offset) plus a
  // small buffer before the Date column's divider line, so wrapped text
  // never touches it.
  return config.columns.date - config.columns.document - 8;
}

/**
 * Pass 1 (counting): rows built straight from the raw plan, before any page
 * numbers exist. Order is simple 1-based position (Assemble has no separate
 * document-reordering/renumbering step distinct from tab position, unlike
 * Stratum's insert/cross-reference model). pageRange/targetPage are
 * placeholders — safe, because rowHeight() never looks at them. Recurses
 * into a tab's own nested sub-tabs (to any depth) in the same interleaved
 * order `assembleStructure()` uses, so a sub-tab's rows/row-count are never
 * silently dropped.
 */
export function buildCountingRows(bundle: PlanBundle, config: IndexLayoutConfig = COURT_INDEX_LAYOUT): IndexRow[] {
  const maxWidth = docColumnMaxWidth(config);
  let order = 0;

  function walk(tab: PlanTab, depth: number): IndexRow[] {
    const rows: IndexRow[] = [{ kind: "tabHeader", label: tab.title, depth }];
    for (const child of tab.children) {
      if (child.kind === "document") {
        order += 1;
        rows.push({
          kind: "doc",
          order,
          documentLines: wrapDocumentName(child.document.title, maxWidth, config.docFontSize),
          date: child.document.date,
          pageRange: "",
          targetPage: 0,
        });
      } else {
        rows.push(...walk(child.tab, depth + 1));
      }
    }
    return rows;
  }

  return bundle.tabs.flatMap((tab) => walk(tab, 0));
}

/**
 * Pass 3 (final): rows rebuilt from the finalized BundleStructure, now with
 * real page numbers/labels. Guaranteed to produce the same row count/heights
 * as buildCountingRows for the same bundle (same titles, same tab
 * structure) — only pageRange/targetPage differ, and neither affects layout.
 * Recurses into nested section (sub-tab) children the same way
 * buildCountingRows does, walking each tab's children in their already-
 * correct interleaved order rather than assuming documents only.
 */
export function buildFinalRows(bundleSetNode: BundleStructureNode, config: IndexLayoutConfig = COURT_INDEX_LAYOUT): IndexRow[] {
  const maxWidth = docColumnMaxWidth(config);
  const docNumbers = computeDocNumbers(bundleSetNode);

  function walk(tab: BundleStructureNode, depth: number): IndexRow[] {
    const rows: IndexRow[] = [{ kind: "tabHeader", label: tab.title, depth }];
    for (const child of tab.children) {
      if (child.type === "document") {
        rows.push({
          kind: "doc",
          order: docNumbers.get(child.id) ?? 0,
          documentLines: wrapDocumentName(child.title, maxWidth, config.docFontSize),
          date: child.date,
          pageRange: pageRangeFor(bundleSetNode.title, child.bundleRelativeStart!, child.bundleRelativeEnd!),
          targetPage: child.startPage,
        });
      } else if (child.type === "section") {
        rows.push(...walk(child, depth + 1));
      }
    }
    return rows;
  }

  return bundleSetNode.children.filter((c) => c.type === "section").flatMap((tab) => walk(tab, 0));
}

function rowHeight(row: IndexRow, config: IndexLayoutConfig): number {
  if (row.kind === "tabHeader") return config.rowHeight;
  const extraLines = Math.max(0, row.documentLines.length - 1);
  return config.rowHeight + extraLines * config.wrapLineHeight;
}

/** Splits rows into pages: page 1 gets the (smaller) heading-page budget, the rest get the full page budget. No dynamic font/row-height scaling — fixed layout, spills across as many pages as needed. */
export function paginateIndexRows(rows: IndexRow[], config: IndexLayoutConfig = COURT_INDEX_LAYOUT): IndexRow[][] {
  const pages: IndexRow[][] = [[]];
  let budget = config.firstPageRowsBudget;
  let used = 0;
  for (const row of rows) {
    const h = rowHeight(row, config);
    if (used + h > budget && pages[pages.length - 1].length > 0) {
      pages.push([]);
      budget = config.continuationRowsBudget;
      used = 0;
    }
    pages[pages.length - 1].push(row);
    used += h;
  }
  return pages;
}
