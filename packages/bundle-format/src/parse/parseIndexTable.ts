// Legacy Node build — needed for text-content parsing server-side (no DOM available), matching outline.ts's import.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export interface ParsedIndexRow {
  /** First page number this row states for its document — bundle-relative, 1-based, whatever the source bundle's own convention is (matches BundleStructureNode.bundleRelativeStart for the same document when the two agree). Null when the source Index has no Pages column at all (a real bundle has been seen deliberately built this way) — callers fall back to matching by row order instead of page position. */
  pageStart: number | null;
  /** Last page number this row states — equals pageStart for a single-page document. Matching callers should check this too, not just pageStart: a tab/section header row (e.g. "4 Exhibit GF3 ... 16-40") states the same *start* page as its first child document, but a much wider range — checking pageEnd is what tells the two apart. Null under the same no-Pages-column condition as pageStart. */
  pageEnd: number | null;
  title: string;
  date: string | null;
}

export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

// Search patterns (no anchors) rather than whole-item matches: one real
// bundle's row had its title and date glued into a single text run with no
// positional gap pdfjs would otherwise expose between them, so the date has
// to be found and extracted as a substring, not assumed to occupy its own
// item. Both "23rd April 2026" (Humphrey's convention) and "28 April 2026"
// (another real bundle's own, no ordinal suffix) have been seen, hence the
// optional suffix.
const NUMERIC_DATE = /\d{1,2}\/\d{1,2}\/\d{2,4}/;
const ORDINAL_DATE =
  /\d{1,2}(st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i;
const PAGES_LIKE = /^\d+(\s*-\s*\d+)?$/;
const BARE_NUMBER = /^\d+$/;
const LEADING_NUMBER = /^(\d+)\s+(.+)$/;
// A real bundle's Index has been seen with a leading "Tab" label column
// (only printed on a tab's first row) ahead of the Document column, in
// place of the bare order number this parser otherwise expects — both are
// a genuinely separate leading column, not part of the title, so both get
// dropped the same way: a wide horizontal gap to the next item is a much
// stronger signal of "separate column" than "is it purely digits", since
// it also covers non-numeric leading labels. Real title-internal word gaps
// (joinTitleItems) have never been seen anywhere near this wide.
const LEADING_COLUMN_GAP = 40;

/** Groups text items into visual rows by Y proximity — real bundles have been seen with items on the same logical row sitting a couple of points apart in Y (different fonts/baselines for different columns), so an exact match is too strict. Exported for reuse by other parsers walking the same Index page's rows (e.g. a future case-heading parser). */
export function groupIntoRows(items: TextItem[]): TextItem[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const Y_TOLERANCE = 4;
  const rows: TextItem[][] = [];
  for (const item of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].y - item.y) <= Y_TOLERANCE) {
      last.push(item);
    } else {
      rows.push([item]);
    }
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  return rows;
}

/** Joins a row's remaining (non-date, non-pages, non-order) items into one title string, inserting a space only where there's real visual separation between items (adjacent punctuation like quote marks has near-zero gap and shouldn't gain a space). */
export function joinTitleItems(items: TextItem[]): string {
  let result = "";
  let prevEnd: number | null = null;
  for (const item of items) {
    if (prevEnd !== null && item.x - prevEnd > 1.5) result += " ";
    result += item.str;
    prevEnd = item.x + item.width;
  }
  return result.trim();
}

/**
 * Extracts one row per document from a single Index page's text content.
 * Deliberately content-and-position based rather than assuming a fixed
 * column layout — real bundles disagree on it (one puts "No." and
 * "Document" in a single combined text item, e.g. "6 20_Two-way_...";
 * another keeps every column as a separate item; one has no Pages column
 * at all). A row counts as a document row if it has a Pages-like value OR
 * a recognizable date — either is enough to tell it apart from header rows
 * ("No. | Document | Date | Pages", no page range and no real date),
 * section/tab header rows, and wrapped continuation lines of a multi-line
 * title (neither a page range nor a date of their own).
 */
function parseRowsFromItems(items: TextItem[]): ParsedIndexRow[] {
  const rows = groupIntoRows(items);
  const result: ParsedIndexRow[] = [];

  for (const row of rows) {
    if (row.length === 0) continue;
    const remaining = [...row];

    // Pages: the rightmost item, if it looks like a page number/range, and
    // sits in the right-hand portion of the page (real bundles' Pages
    // columns have all sat past the horizontal midpoint). Absent entirely
    // on a bundle whose Index has no Pages column — pageStart/pageEnd stay
    // null and matching falls back to row order (see applyIndexTableOverrides).
    let pageStart: number | null = null;
    let pageEnd: number | null = null;
    const rightmost = remaining[remaining.length - 1];
    if (rightmost && PAGES_LIKE.test(rightmost.str.trim()) && rightmost.x >= 300) {
      const pageNumbers = rightmost.str.match(/\d+/g)!;
      pageStart = parseInt(pageNumbers[0], 10);
      pageEnd = pageNumbers.length > 1 ? parseInt(pageNumbers[1], 10) : pageStart;
      remaining.pop();
    }

    // Leading column: an order number ("1") or, on a bundle with no Pages
    // column, a Tab/section label ("Pleadings", "Witness Statements",
    // printed only on that tab's first row) ahead of the Document column —
    // either way it's a separate column, not part of the title. Compared
    // start-x to start-x (not gap-after-width) — a wide label like
    // "Witness Statements" can span almost up to the Document column's own
    // start, leaving near-zero visual gap despite being a separate column.
    // Only checked once there are 3+ items left, so a plain 2-item "title,
    // date" row is never mistaken for one.
    if (remaining.length >= 3 && remaining[1].x - remaining[0].x > LEADING_COLUMN_GAP) {
      remaining.shift();
    } else if (remaining[0] && BARE_NUMBER.test(remaining[0].str.trim())) {
      remaining.shift();
    }

    if (remaining.length === 0) continue;
    let title = joinTitleItems(remaining);

    // Date: search for a date pattern anywhere in the combined text (not
    // just as a standalone item) — see the regex comments above for why.
    let date: string | null = null;
    const dateMatch = title.match(NUMERIC_DATE) ?? title.match(ORDINAL_DATE);
    if (dateMatch && dateMatch.index !== undefined) {
      date = dateMatch[0];
      title = (title.slice(0, dateMatch.index) + title.slice(dateMatch.index + dateMatch[0].length)).trim();
    }

    // A combined "No. Title" item (order number glued to the title text
    // with a space) wasn't caught by the bare-number check above since it
    // has trailing text — strip it here instead.
    const leadingNumberMatch = title.match(LEADING_NUMBER);
    if (leadingNumberMatch) title = leadingNumberMatch[2];
    if (!title) continue;

    // Neither a page range nor a date — this isn't a real document row
    // (header row, or a wrapped continuation line of a multi-line title).
    if (pageStart === null && date === null) continue;

    result.push({ pageStart, pageEnd, title, date });
  }

  return result;
}

/**
 * Parses every page in `pageRange` (0-based, inclusive) of the source PDF as
 * an Index table, returning one row per document found. Pages that don't
 * look tabular at all (e.g. a rotated, word-per-line columnar layout seen on
 * one real bundle) simply yield no rows — callers treat that as "no
 * Index-sourced data available" and fall back to their existing behavior,
 * not an error.
 */
export async function parseIndexTable(
  sourceBytes: Uint8Array,
  pageRange: { start: number; end: number },
): Promise<ParsedIndexRow[]> {
  // Keep the loading task itself, not just its resolved .promise — pdfjs-dist
  // 6.x moved destroy() off PDFDocumentProxy onto PDFDocumentLoadingTask.
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(sourceBytes), useSystemFonts: true });
  const pdfjsDoc = await loadingTask.promise;
  const rows: ParsedIndexRow[] = [];
  for (let pageIndex = pageRange.start; pageIndex <= pageRange.end; pageIndex++) {
    const page = await pdfjsDoc.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    const items: TextItem[] = (content.items as { str?: string; transform?: number[]; width?: number }[])
      .filter((it) => it.str && it.str.trim() && it.transform)
      .map((it) => ({ str: it.str!.trim(), x: it.transform![4], y: it.transform![5], width: it.width ?? 0 }));
    rows.push(...parseRowsFromItems(items));
  }
  await loadingTask.destroy();
  return rows;
}
