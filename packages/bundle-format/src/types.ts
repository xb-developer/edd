// Canonical shape for the whole platform (Assemble/Create/View) to converge
// on when they share this package. Ported from XB View's independently-built
// and validated parser (nested tree, not Stratum's flat node/edge graph —
// chosen as the canonical shape because it's the more general representation
// and is what a tree-rendering UI needs directly).

export type NodeType = "bundleSet" | "section" | "document" | "index";

export interface BundleStructureNode {
  id: string;
  type: NodeType;
  /** Display name only — no leading document number, no trailing date (see `date`). */
  title: string;
  rawTitle: string;
  date: string | null;
  /** 0-based absolute page index into the source PDF, inclusive. */
  startPage: number;
  /** 0-based absolute page index into the source PDF, inclusive. */
  endPage: number;
  /** 1-based, relative to the nearest bundleSet ancestor's baseline. Null for bundleSet nodes themselves. */
  bundleRelativeStart: number | null;
  bundleRelativeEnd: number | null;
  /** Nearest bundleSet ancestor's title ("" for the untitled/flat-bundle case). */
  bundleLabel: string | null;
  depth: number;
  children: BundleStructureNode[];
}

export interface BundleStructure {
  totalPages: number;
  roots: BundleStructureNode[];
}
