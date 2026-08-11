import type { CSSProperties } from "react";
import type { ApiClient } from "./api";
import type { TagSetDTO } from "./types";
import { ExportButtons } from "./ExportButtons";

export interface FilterPanelProps {
  api: ApiClient;
  matterId: string;
  style?: CSSProperties;
  tagSets: TagSetDTO[];
  appliedTagsByDocument: Record<string, string[]>;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  selectedTagIds: string[];
  onToggleTagId: (tagId: string) => void;
  matchMode: "all" | "any";
  onMatchModeChange: (mode: "all" | "any") => void;
  onClearTagFilter: () => void;
  /** The bulk-select checkbox column's checked ids (MatterDetail's `checkedDocumentIds`) — both exports are scoped to exactly this set, never "everything in the matter." */
  selectedDocumentIds: string[];
}

/**
 * Search + tag filter + export, matching the POC's left-column layout.
 * Search is a real (client-side, filename-substring) filter over the
 * matter's already-loaded document list — no search backend exists yet, so
 * this is the honest version of that feature rather than a Boolean/FTS
 * mockup with no engine behind it. Tag filtering is genuinely interactive
 * against the same mocked tag state CodingPanel writes to (see api.ts) —
 * counts and matches update live as tags are toggled elsewhere.
 */
export function FilterPanel({
  api,
  matterId,
  style,
  tagSets,
  appliedTagsByDocument,
  searchQuery,
  onSearchQueryChange,
  selectedTagIds,
  onToggleTagId,
  matchMode,
  onMatchModeChange,
  onClearTagFilter,
  selectedDocumentIds,
}: FilterPanelProps) {
  const allTags = tagSets.flatMap((tagSet) => tagSet.tags);
  const countForTag = (tagId: string) => Object.values(appliedTagsByDocument).filter((tagIds) => tagIds.includes(tagId)).length;

  return (
    <section className="col col-left" style={style}>
      <div className="section">
        <h2 className="panel-title">Search</h2>
        <input className="search-box" placeholder="Search filenames…" value={searchQuery} onChange={(e) => onSearchQueryChange(e.target.value)} />
      </div>

      <div className="section">
        <h2 className="panel-title">Tag Filter</h2>
        {allTags.length === 0 ? (
          <p className="empty-note">No tags configured for this matter.</p>
        ) : (
          <>
            <div className="mode-toggle">
              <button type="button" className={matchMode === "all" ? "active" : ""} onClick={() => onMatchModeChange("all")}>
                Match all
              </button>
              <button type="button" className={matchMode === "any" ? "active" : ""} onClick={() => onMatchModeChange("any")}>
                Match any
              </button>
            </div>
            <div className="tag-filter-list">
              {allTags.map((tag) => (
                <label key={tag.id} className="tag-filter-row">
                  <input type="checkbox" checked={selectedTagIds.includes(tag.id)} onChange={() => onToggleTagId(tag.id)} />
                  <span className="tag-dot" style={{ background: tag.color ?? "var(--ink-soft)" }} />
                  <span>{tag.name}</span>
                  <span className="cnt">{countForTag(tag.id)}</span>
                </label>
              ))}
            </div>
            {selectedTagIds.length > 0 && (
              <button type="button" className="clear-filters" onClick={onClearTagFilter}>
                Clear tag filter
              </button>
            )}
          </>
        )}
      </div>

      <div className="section">
        <h2 className="panel-title">Export</h2>
        <ExportButtons api={api} matterId={matterId} selectedDocumentIds={selectedDocumentIds} />
        <p className="export-hint">
          {selectedDocumentIds.length === 0
            ? "Check documents in the table to enable export."
            : `Exports the ${selectedDocumentIds.length} currently checked document${selectedDocumentIds.length === 1 ? "" : "s"} — as a zip (Export documents) or a metadata CSV (Export properties).`}
        </p>
      </div>
    </section>
  );
}
