import type { BundleStructure, BundleStructureNode, NodeType } from "../types.js";
import { parseIndexTable, type ParsedIndexRow } from "./parseIndexTable.js";

// A real index table has been found to cover most (usually all) of its
// bundle set's real documents. One real bundle's Index page turned out to be
// a rotated, word-per-line columnar layout that doesn't fit the row model
// this parser assumes at all — it still produced a handful of "rows" (odd
// numbers accidentally extracted from wrapped text), and trusting even one
// of those risks corrupting a real, unrelated document via a coincidental
// page-number collision. A wildly-undercounted result is a sign the whole
// page's "rows" are noise, not real data, so the safe response is to discard
// all of them for that bundle set — every document then keeps whatever
// buildStructure already resolved from its bookmark title.
const MIN_COVERAGE_RATIO = 0.5;

/** Recursively collects every descendant node of the given type, in document (page) order — used to gather a bundleSet's index pages and document leaves without assuming a fixed nesting depth (a document can sit directly under a bundleSet on a flat/untabbed bundle, or under a tab on a real one). Exported for reuse by openBundle.ts, which walks the same tree to split documents out per tab. */
export function collectByType(node: BundleStructureNode, type: NodeType, out: BundleStructureNode[]): void {
  if (node.type === type) out.push(node);
  for (const child of node.children) collectByType(child, type, out);
}

/**
 * A real bundle was found whose printed Index numbers every document a
 * constant N pages earlier than its true bundle-relative position — the
 * Index itself spans N pages, and whatever produced this bundle apparently
 * numbered the Index's "Pages" column starting from 1 = the first page
 * *after* the index, while this pipeline's own bundleRelativeStart counts
 * the index's own pages as part of the bundle (index's first page = 1) —
 * a real, external authoring-convention mismatch, not noise. Every row's
 * title/date/order/span-width still lined up exactly with the real
 * documents (confirmed by walking both lists in page order), only the
 * absolute page numbers were shifted by one constant amount throughout.
 *
 * Detects that constant offset (0 in the common case where the Index
 * already agrees with this pipeline's numbering) by pairing rows and
 * documents at the same position in page order and taking the most common
 * `doc.bundleRelativeStart - row.pageStart` among pairs whose page-SPAN
 * WIDTH agrees — width agreement is a strong, offset-independent signal
 * that a given pair is a genuine correspondence (a tab/section-header row
 * spans far wider than the single document it might otherwise
 * coincidentally align with, so it won't contribute a vote).
 */
function detectPageOffset(
  rows: (ParsedIndexRow & { pageStart: number; pageEnd: number })[],
  documents: BundleStructureNode[],
): number {
  const sortedRows = [...rows].sort((a, b) => a.pageStart - b.pageStart);
  const sortedDocs = [...documents].sort((a, b) => a.bundleRelativeStart! - b.bundleRelativeStart!);
  const offsetVotes = new Map<number, number>();
  const n = Math.min(sortedRows.length, sortedDocs.length);
  for (let i = 0; i < n; i++) {
    const row = sortedRows[i];
    const doc = sortedDocs[i];
    if (row.pageEnd - row.pageStart !== doc.bundleRelativeEnd! - doc.bundleRelativeStart!) continue;
    const offset = doc.bundleRelativeStart! - row.pageStart;
    offsetVotes.set(offset, (offsetVotes.get(offset) ?? 0) + 1);
  }
  let bestOffset = 0;
  let bestVotes = 0;
  for (const [offset, votes] of offsetVotes) {
    if (votes > bestVotes) {
      bestOffset = offset;
      bestVotes = votes;
    }
  }
  return bestOffset;
}

function applyOverrides(nodes: BundleStructureNode[], overrides: Map<string, { title: string; date: string | null }>): BundleStructureNode[] {
  return nodes.map((node) => {
    const override = overrides.get(node.id);
    const children = applyOverrides(node.children, overrides);
    return override ? { ...node, title: override.title, date: override.date, children } : { ...node, children };
  });
}

/**
 * Overrides each document's title/date with its matching row from the
 * source bundle's own Index table, when one can be found — the bundle's own
 * Index is the source of truth for both, ahead of whatever the bookmark
 * title itself says (even when the bookmark title also has a parseable
 * date). A document with no matching row (either because the Index table
 * couldn't be read reliably, or that specific page genuinely has no row)
 * keeps whatever buildStructure already resolved from its bookmark title.
 *
 * Ported from Stratum/Create's applyIndexTableOverrides.ts, adapted from its
 * flat node/edge graph to this package's nested BundleStructureNode tree —
 * the matching algorithm itself (coverage gate, offset detection,
 * page-position matching with a no-Pages-column row-order fallback) is
 * unchanged.
 */
export async function applyIndexTableOverrides(structure: BundleStructure, sourceBytes: Uint8Array): Promise<BundleStructure> {
  const overrides = new Map<string, { title: string; date: string | null }>();

  // Collected recursively, not just from structure.roots directly — a real
  // bundle has been seen with its lettered bundle sets nested one level
  // deeper than usual, under an extra wrapping "version label" container
  // that isn't itself a bundleSet. A top-level-only loop would silently skip
  // every one of those bundle sets' documents entirely.
  const bundleSets: BundleStructureNode[] = [];
  for (const root of structure.roots) collectByType(root, "bundleSet", bundleSets);

  for (const bundleSet of bundleSets) {
    const indexNodes: BundleStructureNode[] = [];
    collectByType(bundleSet, "index", indexNodes);
    const documents: BundleStructureNode[] = [];
    collectByType(bundleSet, "document", documents);
    if (indexNodes.length === 0 || documents.length === 0) continue;

    const rows: ParsedIndexRow[] = [];
    for (const indexNode of indexNodes) {
      rows.push(...(await parseIndexTable(sourceBytes, { start: indexNode.startPage, end: indexNode.endPage })));
    }
    if (rows.length < documents.length * MIN_COVERAGE_RATIO) continue;

    const pageRows = rows.filter((r): r is ParsedIndexRow & { pageStart: number; pageEnd: number } => r.pageStart !== null);

    if (pageRows.length === 0) {
      // The source Index has no Pages column at all — page-position
      // matching is impossible, so fall back to matching purely by row
      // order: both rows and documents were read top-to-bottom in physical
      // page order, so the Nth row is the Nth document.
      const sortedDocs = [...documents].sort((a, b) => a.bundleRelativeStart! - b.bundleRelativeStart!);
      const n = Math.min(rows.length, sortedDocs.length);
      for (let i = 0; i < n; i++) {
        overrides.set(sortedDocs[i].id, { title: rows[i].title, date: rows[i].date });
      }
      continue;
    }

    const offset = detectPageOffset(pageRows, documents);

    const byPageStart = new Map<number, ParsedIndexRow & { pageStart: number; pageEnd: number }>();
    for (const row of pageRows) {
      const adjustedStart = row.pageStart + offset;
      if (!byPageStart.has(adjustedStart)) byPageStart.set(adjustedStart, row);
    }

    for (const doc of documents) {
      const row = byPageStart.get(doc.bundleRelativeStart!);
      // Require the end page to match too, not just the start — a
      // tab/section header row states the same start page as its first
      // child document but spans the whole section, not one document.
      if (!row || row.pageEnd + offset !== doc.bundleRelativeEnd) continue;
      overrides.set(doc.id, { title: row.title, date: row.date });
    }
  }

  if (overrides.size === 0) return structure;
  return { ...structure, roots: applyOverrides(structure.roots, overrides) };
}
