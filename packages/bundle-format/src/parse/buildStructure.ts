import type { RawOutlineItem } from "./outline.js";
import { cleanDocumentTitle, isIndexTitle } from "./titleParsing.js";
import type { BundleStructure, BundleStructureNode, NodeType } from "../types.js";

interface DraftNode {
  rawTitle: string;
  title: string;
  date: string | null;
  type: NodeType;
  ownPageIndex: number;
  startPage: number;
  endPage: number;
  depth: number;
  children: DraftNode[];
  isLeaf: boolean;
}

function classify(item: RawOutlineItem, depth: number): DraftNode {
  const hasChildren = item.children.length > 0;
  const childDrafts = hasChildren ? item.children.map((c) => classify(c, depth + 1)) : [];

  let type: NodeType;
  if (!hasChildren) {
    type = isIndexTitle(item.title) ? "index" : "document";
  } else {
    const hasIndexChild = item.children.some((c) => isIndexTitle(c.title));
    type = hasIndexChild ? "bundleSet" : "section";
  }

  const cleaned = type === "document" ? cleanDocumentTitle(item.title) : { name: item.title.trim(), date: null };

  return {
    rawTitle: item.title,
    title: type === "index" ? "Index" : cleaned.name,
    date: cleaned.date,
    type,
    ownPageIndex: item.pageIndex,
    startPage: -1,
    endPage: -1,
    depth,
    children: childDrafts,
    isLeaf: !hasChildren,
  };
}

function incrementDepth(node: DraftNode): DraftNode {
  return { ...node, depth: node.depth + 1, children: node.children.map(incrementDepth) };
}

function collectLeavesInOrder(nodes: DraftNode[], out: DraftNode[]): void {
  for (const node of nodes) {
    if (node.isLeaf) {
      out.push(node);
    } else {
      collectLeavesInOrder(node.children, out);
    }
  }
}

/**
 * Leaf end page = next leaf's start - 1 (last leaf runs to end of document);
 * container ranges = min/max of descendant leaves. End pages are derived,
 * never trusted from the outline dict directly.
 */
function assignPageRanges(roots: DraftNode[], totalPages: number): void {
  const leaves: DraftNode[] = [];
  collectLeavesInOrder(roots, leaves);
  leaves.forEach((leaf, i) => {
    leaf.startPage = leaf.ownPageIndex;
    leaf.endPage = i + 1 < leaves.length ? leaves[i + 1].ownPageIndex - 1 : totalPages - 1;
  });

  function computeContainerRange(node: DraftNode): void {
    if (node.isLeaf) return;
    for (const child of node.children) computeContainerRange(child);
    node.startPage = Math.min(...node.children.map((c) => c.startPage));
    node.endPage = Math.max(...node.children.map((c) => c.endPage));
  }
  for (const root of roots) computeContainerRange(root);
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function finalize(
  node: DraftNode,
  parentBundleLabel: string | null,
  parentBaseline: number | null,
  prefix: string,
): BundleStructureNode {
  const id = nextId(prefix);

  let ownBundleLabel = parentBundleLabel;
  let ownBaseline = parentBaseline;
  let bundleRelativeStart: number | null = null;
  let bundleRelativeEnd: number | null = null;

  if (node.type === "bundleSet") {
    // A bundle set restarts numbering for everything inside it; its own
    // position "relative to itself" isn't a meaningful concept, so it's left null.
    ownBundleLabel = node.title;
    const indexChild = node.children.find((c) => c.type === "index");
    ownBaseline = indexChild ? indexChild.startPage : Math.min(...node.children.map((c) => c.startPage));
  } else if (parentBaseline !== null) {
    bundleRelativeStart = node.startPage - parentBaseline + 1;
    bundleRelativeEnd = node.endPage - parentBaseline + 1;
  }

  const children = node.children.map((c, i) => finalize(c, ownBundleLabel, ownBaseline, `${id}-${i}`));

  return {
    id,
    type: node.type,
    title: node.title,
    rawTitle: node.rawTitle,
    date: node.date,
    startPage: node.startPage,
    endPage: node.endPage,
    bundleRelativeStart,
    bundleRelativeEnd,
    bundleLabel: ownBundleLabel,
    depth: node.depth,
    children,
  };
}

// Checked recursively, not just among top-level roots — a real bundle has
// been seen with its lettered bundle sets (A/B/B2/C, each with their own
// Index child, exactly the normal convention) nested one level deeper than
// usual, under an extra wrapping "version label" container that itself has
// no Index child. A top-level-only check would wrongly conclude no bundle
// set exists and add a redundant *outer* synthetic one around the real
// ones — harmless for a simple nearest-ancestor lookup, but corrupting for
// anything that walks *all* bundleSets independently (applyIndexTableOverrides
// would then also run its own pass across the whole file as if it were one
// giant bundle, on top of the correct per-lettered-bundle passes, risking a
// row from one bundle's Index page getting matched against another
// bundle's document).
function hasBundleSetAnywhere(nodes: DraftNode[]): boolean {
  return nodes.some((n) => n.type === "bundleSet" || hasBundleSetAnywhere(n.children));
}

export function buildStructure(outline: RawOutlineItem[], totalPages: number): BundleStructure {
  idCounter = 0;
  let draftRoots = outline.map((item) => classify(item, 0));

  if (!hasBundleSetAnywhere(draftRoots)) {
    // Flat-bundle fallback: no lettered bundle-set wrapper at all — wrap the
    // whole outline in one synthetic, untitled bundle set so downstream logic
    // is uniform. Originally only fired when a top-level Index bookmark was
    // present (the shape Stratum's own flat/untitled export produces), but a
    // real bundle has been seen that has no bookmarked Index page at all —
    // just section/tab containers (or, on one file in the same set, a
    // completely flat list of document bookmarks) with real documents inside.
    // That's an extremely common real-world convention (many bundle tools
    // never bookmark the printed index page itself), so this fallback now
    // fires whenever nothing was recognised as an intentional multi-bundle-
    // set container — not just when there happens to be an Index bookmark.
    const synthetic: DraftNode = {
      rawTitle: "",
      title: "",
      date: null,
      type: "bundleSet",
      ownPageIndex: 0,
      startPage: -1,
      endPage: -1,
      depth: 0,
      children: draftRoots.map(incrementDepth),
      isLeaf: false,
    };
    draftRoots = [synthetic];
  }

  assignPageRanges(draftRoots, totalPages);
  const roots = draftRoots.map((r, i) => finalize(r, null, null, `n${i}`));
  return { totalPages, roots };
}
