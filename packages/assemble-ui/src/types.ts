export interface DocumentDTO {
  id: string;
  title: string;
  date: string | null;
  sourcePath: string;
  pageCount: number;
  /** Shared order space with sibling sub-tabs under the same parent tab — merge on this when the true interleaved order matters (see TabDTO.tabs). */
  displayOrder: number;
}

export interface TabDTO {
  id: string;
  title: string;
  displayOrder: number;
  documents: DocumentDTO[];
  /** Nested sub-tabs, to any depth — kept as a separate array from `documents` rather than one merged list; `displayOrder` on both is what you merge-sort on when the true interleaved order is needed. */
  tabs: TabDTO[];
}

export interface BundleDTO {
  id: string;
  /** Full free-text display name, e.g. "Hearing Bundle CCMC before Judge Grocer". */
  title: string;
  /** Short citation prefix used in page references ("A-2") and /PageLabels — never the full title. */
  label: string;
  tabs: TabDTO[];
}

export interface AssemblyView {
  bundles: BundleDTO[];
  staging: DocumentDTO[];
}

export interface CaseHeadingDTO {
  claimNoLabel: string;
  preamble: string[];
  courtLines: string[];
  claimants: string[];
  claimantsLabel: string;
  vLabel: string;
  defendants: string[];
  defendantsLabel: string;
}
