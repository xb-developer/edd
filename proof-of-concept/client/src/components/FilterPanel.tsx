import type { CSSProperties } from "react";
import type { FilterMode, Tag } from "../types";

interface Props {
  q: string;
  onQChange: (q: string) => void;
  tags: Tag[];
  tagFilterIds: number[];
  onToggleTagFilter: (id: number) => void;
  mode: FilterMode;
  onModeChange: (mode: FilterMode) => void;
  onClearFilters: () => void;
  exportCount: number;
  checkedCount: number;
  onExportZip: () => void;
  onExportCsv: () => void;
  style?: CSSProperties;
}

export function FilterPanel({
  q,
  onQChange,
  tags,
  tagFilterIds,
  onToggleTagFilter,
  mode,
  onModeChange,
  onClearFilters,
  exportCount,
  checkedCount,
  onExportZip,
  onExportCsv,
  style,
}: Props) {
  return (
    <section className="col col-left" style={style}>
      <div className="section">
        <h2 className="panel-title">Search</h2>
        <input
          className="search-box"
          placeholder="Filter by filename, title, author…"
          value={q}
          onChange={(e) => onQChange(e.target.value)}
        />
        <div className="export-hint" style={{ marginTop: -8 }}>
          Searches extracted document text and metadata. Supports{" "}
          <code>AND</code>/<code>OR</code>/<code>NOT</code>, <code>"exact phrase"</code>, and <code>prefix*</code>.
        </div>
      </div>

      <div className="section">
        <h2 className="panel-title">Tag filter</h2>
        <div className="mode-toggle">
          <button className={mode === "all" ? "active" : ""} onClick={() => onModeChange("all")}>
            Match all
          </button>
          <button className={mode === "any" ? "active" : ""} onClick={() => onModeChange("any")}>
            Match any
          </button>
        </div>
        <div className="tag-filter-list">
          {tags.length === 0 ? (
            <div className="empty-note">No tags yet</div>
          ) : (
            tags.map((t) => (
              <label key={t.id} className="tag-filter-row">
                <input
                  type="checkbox"
                  checked={tagFilterIds.includes(t.id)}
                  onChange={() => onToggleTagFilter(t.id)}
                />
                <span className="tag-dot" style={{ background: t.color }} />
                {t.name}
              </label>
            ))
          )}
        </div>
        {tagFilterIds.length > 0 && (
          <button className="clear-filters" onClick={onClearFilters}>
            Clear tag filter
          </button>
        )}
      </div>

      <div className="section">
        <h2 className="panel-title">Export</h2>
        <button className="export-btn" disabled={exportCount === 0} onClick={onExportZip}>
          <span className="ico">▤</span> Export documents (.zip)
        </button>
        <button className="export-btn" disabled={exportCount === 0} onClick={onExportCsv}>
          <span className="ico">▥</span> Export metadata (.csv)
        </button>
        <div className="export-hint">
          {checkedCount > 0
            ? `Exports apply to the ${checkedCount} row${checkedCount === 1 ? "" : "s"} you've checked.`
            : `No rows checked — exports will apply to all ${exportCount} row${exportCount === 1 ? "" : "s"} in the current filtered view.`}{" "}
          Files in the zip are named by GUID.
        </div>
      </div>
    </section>
  );
}
