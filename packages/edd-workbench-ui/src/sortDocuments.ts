import type { DocumentDTO } from "./types";

export type SortDirection = "asc" | "desc";

// Every column actually rendered as a plain, single-valued cell in
// MatterDetail.tsx's table — "Tags" (a chip list) and "To"/"Cc" (nested
// inside `metadata`, not a top-level DocumentDTO field) are deliberately
// not included here, not an oversight.
export type SortableColumn = "guid" | "familyGuid" | "originalFilename" | "extension" | "sizeBytes" | "docDate" | "fileModifiedAt" | "author";

/**
 * Sorts a real, unpadded copy of `docs` by one column, ascending or
 * descending. Handles every value shape the sortable columns actually
 * have: `guid`/`familyGuid` are zero-padded fixed-width numeric strings
 * (formatGuid), so a plain string comparison already sorts them
 * numerically; `sizeBytes` is a real number; `docDate`/`fileModifiedAt`
 * are ISO 8601 strings, whose lexical order already matches chronological
 * order for same-format timestamps, so no Date parsing is needed either.
 *
 * A null value (author/docDate/fileModifiedAt can all be null) always
 * sorts to the END, in BOTH directions — not merely "smallest ascending,
 * largest descending" (what a naive comparator-then-reverse would give),
 * since a missing value isn't meaningfully "highest" when sorting
 * descending; it's just missing, and reviewers scanning a sorted column
 * expect the real values grouped together regardless of direction.
 */
export function sortDocuments<T extends DocumentDTO>(docs: T[], column: SortableColumn, direction: SortDirection): T[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...docs].sort((a, b) => {
    const va = a[column];
    const vb = b[column];
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * multiplier;
    return String(va).localeCompare(String(vb)) * multiplier;
  });
}
