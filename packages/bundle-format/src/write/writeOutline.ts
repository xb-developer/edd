import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib";
import type { BundleStructure, BundleStructureNode } from "../types.js";
import { computeDocNumbers, renumberedTitle } from "./docNumbering.js";
import { findBundleSets } from "./treeUtils.js";
import { escapePdfString } from "./pdfStringEscape.js";

/**
 * Bookmark titles for documents carry their current sequence number within
 * the bundle set and a "(page X-Y)" page reference, both regenerated fresh
 * from the live structure every time the outline is written, so neither can
 * go stale the way a hand-typed or one-off-stamped reference would.
 */
function labelFor(node: BundleStructureNode, docNumbers: Map<string, number>): string {
  if (node.type === "index") return "Index";
  if (node.type === "document") {
    const numbered = renumberedTitle(node.title, node.date, docNumbers.get(node.id));
    // An untitled (flat, single-set) bundle's own bookmarks carry a bare
    // "(page N)" suffix with no letter — keep that convention rather than
    // dropping the suffix entirely.
    const pageRef = node.bundleLabel ? `${node.bundleLabel}-${node.bundleRelativeStart}` : String(node.bundleRelativeStart);
    return `${numbered} (page ${pageRef})`;
  }
  return node.title;
}

/**
 * The domain model still tracks the Index as one leaf node per physical
 * page internally (that's what makes "grow the Index by a page" just
 * another ordinary insertion, the same mechanism every other document uses
 * — no special-cased "extend this node's range" operation needed). But a
 * bundle's Index is conceptually one document, exactly like a 15-page
 * witness statement is one document with one bookmark, not fifteen — so at
 * the point the bookmark tree is actually written, a run of adjacent
 * "index" siblings collapses into a single "Index" bookmark pointing at the
 * first page, the same shape every other multi-page item already gets.
 * Index continuation pages are always physically contiguous by
 * construction (they only ever exist immediately after the Index's own
 * first page), so "adjacent in the sibling list" is a safe test for "same
 * logical Index" — no page-number check needed.
 */
function consolidateAdjacentIndexSiblings(items: BundleStructureNode[]): BundleStructureNode[] {
  const out: BundleStructureNode[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (item.type === "index" && prev?.type === "index") continue;
    out.push(item);
  }
  return out;
}

/**
 * Rebuilds the PDF's bookmark outline from scratch to match the
 * BundleStructure, using pdf-lib's low-level object API (pdf-lib has no
 * high-level outline builder). Every outline item gets a
 * Title/Parent/Dest/Next/Prev, and each container gets First/Last/Count
 * over its own descendants.
 */
export function writeOutline(pdfDoc: PDFDocument, structure: BundleStructure): void {
  const context = pdfDoc.context;

  const docNumbers = new Map<string, number>();
  for (const bundleSet of findBundleSets(structure.roots)) {
    for (const [id, num] of computeDocNumbers(bundleSet)) docNumbers.set(id, num);
  }

  function destFor(n: BundleStructureNode) {
    const page = pdfDoc.getPage(n.startPage);
    return context.obj([page.ref, PDFName.of("Fit")]);
  }

  function buildLevel(
    rawItems: BundleStructureNode[],
    parentRef: PDFRef,
  ): { firstRef: PDFRef; lastRef: PDFRef; totalCount: number } | null {
    const items = consolidateAdjacentIndexSiblings(rawItems);
    if (items.length === 0) return null;

    const built = items.map((item) => {
      const dict = context.obj({
        Title: PDFString.of(escapePdfString(labelFor(item, docNumbers))),
        Parent: parentRef,
        Dest: destFor(item),
      }) as PDFDict;
      const ref = context.register(dict);
      return { item, ref, dict };
    });

    for (let i = 0; i < built.length; i++) {
      if (i > 0) built[i].dict.set(PDFName.of("Prev"), built[i - 1].ref);
      if (i < built.length - 1) built[i].dict.set(PDFName.of("Next"), built[i + 1].ref);
    }

    let totalCount = items.length;
    for (const entry of built) {
      const childResult = buildLevel(entry.item.children, entry.ref);
      if (childResult) {
        entry.dict.set(PDFName.of("First"), childResult.firstRef);
        entry.dict.set(PDFName.of("Last"), childResult.lastRef);
        entry.dict.set(PDFName.of("Count"), PDFNumber.of(childResult.totalCount));
        totalCount += childResult.totalCount;
      }
    }

    return { firstRef: built[0].ref, lastRef: built[built.length - 1].ref, totalCount };
  }

  const outlinesDict = context.obj({ Type: PDFName.of("Outlines") }) as PDFDict;
  const outlinesRef = context.register(outlinesDict);
  const top = buildLevel(structure.roots, outlinesRef);
  if (top) {
    outlinesDict.set(PDFName.of("First"), top.firstRef);
    outlinesDict.set(PDFName.of("Last"), top.lastRef);
    outlinesDict.set(PDFName.of("Count"), PDFNumber.of(top.totalCount));
  }

  pdfDoc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  pdfDoc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}
