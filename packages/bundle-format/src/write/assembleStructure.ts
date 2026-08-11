import type { BundleStructure, BundleStructureNode } from "../types.js";

// The input shape Assemble's own domain model produces: an ordered plan of
// bundles/tabs/documents with known source files and page counts, but no
// page-range/relative-numbering information yet (that's derived below,
// exactly the same way the parser derives it from a real PDF outline — the
// only difference is the source of truth is an assembly plan instead of an
// existing bookmark tree).

export interface PlanDocument {
  title: string;
  date: string | null;
  sourcePath: string;
  pageCount: number;
}

/**
 * A tab's contents in true document/page order — a loose document and a
 * nested sub-tab can be freely interleaved (a real bundle has been seen with
 * documents both before *and* after a nested sub-tab within the same outer
 * tab), so this is one ordered list of either kind rather than two separate
 * arrays that would force all documents before all sub-tabs.
 */
export type PlanTabChild = { kind: "document"; document: PlanDocument } | { kind: "tab"; tab: PlanTab };

export interface PlanTab {
  title: string;
  children: PlanTabChild[];
}

export interface PlanBundle {
  /**
   * Short citation label/letter, e.g. "A" — used for the bundle's outline
   * bookmark text, page-reference prefixes ("A-2"), and /PageLabels. Empty
   * string for a single flat/untitled bundle (bare page numbers, no prefix).
   * Deliberately NOT a free-text display name — a full descriptive bundle
   * name is a separate, Assemble-only concept that never enters the exported
   * file (see the server's `bundles.title` column vs this `label`) precisely
   * to avoid it leaking into page-reference text.
   */
  label: string;
  tabs: PlanTab[];
}

export interface AssemblyPlan {
  bundles: PlanBundle[];
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/**
 * Assigns sequential absolute page ranges across the whole plan (bundle by
 * bundle, tab by tab, document by document, in plan order) and derives
 * bundle-relative numbers the same way the parser does: relative to each
 * bundle's own first Index page, matching the real parser's convention of
 * baselining on the index child.
 *
 * `indexPageCounts` (one entry per plan bundle, same order) must be known
 * ahead of time — see exportBundle.ts's counting pass — because a bundle's
 * own Index can span multiple physical pages. Each index page becomes its
 * own `type: "index"` leaf (never one node spanning N pages), matching the
 * established real-world convention of one index node per physical index
 * page (confirmed both by parsing a real Stratum export directly and by
 * Stratum's own index-growth logic, which always adds a new index-type node
 * for a continuation page rather than extending an existing one's range).
 */
export function assembleStructure(plan: AssemblyPlan, indexPageCounts: number[]): BundleStructure {
  idCounter = 0;
  let cursor = 0;
  const roots: BundleStructureNode[] = [];

  plan.bundles.forEach((bundle, bundleIndex) => {
    const bundleId = nextId("bundle");
    const bundleStart = cursor;
    const indexPageCount = indexPageCounts[bundleIndex] ?? 1;

    const indexNodes: BundleStructureNode[] = [];
    for (let i = 0; i < indexPageCount; i++) {
      const pageStart = cursor;
      cursor += 1;
      indexNodes.push({
        id: nextId("index"),
        type: "index",
        title: "Index",
        rawTitle: "Index",
        date: null,
        startPage: pageStart,
        endPage: pageStart,
        bundleRelativeStart: pageStart - bundleStart + 1,
        bundleRelativeEnd: pageStart - bundleStart + 1,
        bundleLabel: bundle.label,
        depth: 1,
        children: [],
      });
    }

    // Builds one tab's section node, walking `children` in order — a loose
    // document and a nested sub-tab are handled by the same loop, so
    // whatever interleaving the plan specifies (docs before *and* after a
    // sub-tab, at any depth) is preserved exactly, with no fixed shape
    // assumed.
    function buildTabNode(tab: PlanTab, depth: number): BundleStructureNode {
      const tabId = nextId("tab");
      const tabStart = cursor;
      const childNodes: BundleStructureNode[] = [];

      for (const child of tab.children) {
        if (child.kind === "document") {
          const doc = child.document;
          const docStart = cursor;
          const docEnd = cursor + doc.pageCount - 1;
          cursor += doc.pageCount;
          childNodes.push({
            id: nextId("doc"),
            type: "document",
            title: doc.title,
            rawTitle: doc.title,
            date: doc.date,
            startPage: docStart,
            endPage: docEnd,
            bundleRelativeStart: docStart - bundleStart + 1,
            bundleRelativeEnd: docEnd - bundleStart + 1,
            bundleLabel: bundle.label,
            depth: depth + 1,
            children: [],
          });
        } else {
          childNodes.push(buildTabNode(child.tab, depth + 1));
        }
      }

      // Children are built in strictly increasing cursor order (documents
      // advance it directly; nested tabs recurse before returning), so the
      // last child's endPage is always the tab's own endPage — same
      // shortcut the original flat version used, still valid once nesting
      // is allowed since order is never a concern.
      const tabEnd = childNodes.length > 0 ? childNodes[childNodes.length - 1].endPage : tabStart - 1;
      return {
        id: tabId,
        type: "section",
        title: tab.title,
        rawTitle: tab.title,
        date: null,
        startPage: tabStart,
        endPage: tabEnd,
        bundleRelativeStart: tabStart - bundleStart + 1,
        bundleRelativeEnd: tabEnd - bundleStart + 1,
        bundleLabel: bundle.label,
        depth,
        children: childNodes,
      };
    }

    const tabNodes: BundleStructureNode[] = [...indexNodes, ...bundle.tabs.map((tab) => buildTabNode(tab, 1))];

    const bundleEnd = cursor - 1;
    roots.push({
      id: bundleId,
      type: "bundleSet",
      title: bundle.label,
      rawTitle: bundle.label,
      date: null,
      startPage: bundleStart,
      endPage: bundleEnd,
      bundleRelativeStart: null,
      bundleRelativeEnd: null,
      bundleLabel: bundle.label,
      depth: 0,
      children: tabNodes,
    });
  });

  return { totalPages: cursor, roots };
}

/**
 * Every document in a tab's subtree, in true document order — loose
 * documents and nested sub-tabs' documents interleaved exactly as they
 * appear in `children`. This is the order physical PDF pages must be copied
 * in (see exportBundle.ts), and it can never disagree with
 * assembleStructure()'s own page-numbering walk above: both are a plain
 * in-order walk of the same `children` arrays.
 */
export function flattenPlanTabDocuments(tab: PlanTab): PlanDocument[] {
  const out: PlanDocument[] = [];
  for (const child of tab.children) {
    if (child.kind === "document") out.push(child.document);
    else out.push(...flattenPlanTabDocuments(child.tab));
  }
  return out;
}

/** Flat, page-ordered list of every document in the plan, for driving PDF concatenation. */
export function flattenPlanDocuments(plan: AssemblyPlan): PlanDocument[] {
  return plan.bundles.flatMap((b) => b.tabs.flatMap(flattenPlanTabDocuments));
}
