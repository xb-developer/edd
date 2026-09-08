import { useEffect, useState } from "react";
import type { ApiClient } from "./api";
import type { TagSetDTO } from "./types";

export interface CodingPanelProps {
  api: ApiClient;
  matterId: string;
  documentId: string;
  /** Independent of `documentId` — the bulk-select checkbox column's checked ids. Non-empty switches the whole panel into bulk-apply mode; `documentId` (the single-preview target) is ignored while that's the case. */
  bulkSelectedDocumentIds: string[];
  onClearBulkSelection: () => void;
  /** Lifted to MatterDetail (shared with FilterPanel's tag filter, avoiding a duplicate fetch) rather than fetched here. */
  tagSets: TagSetDTO[];
  /** Called after a tag is applied/removed, or a custom code is created, so FilterPanel's tag-filter counts/options and tagSets stay live. */
  onTagsChanged: () => void;
  /** Walks the matter's (already server-ordered) document list — same selection state that also drives the docked/popped-out viewer, so Prev/Next updates whichever one is active. */
  onPrev: () => void;
  onNext: () => void;
  canGoPrev: boolean;
  canGoNext: boolean;
}

// Scaffolded ahead of the coding/tagging backend originally (see api.ts's
// history) — now backed by a real matter-scoped schema (tag_sets/tags/
// document_tags).
export function CodingPanel({
  api,
  matterId,
  documentId,
  bulkSelectedDocumentIds,
  onClearBulkSelection,
  tagSets,
  onTagsChanged,
  onPrev,
  onNext,
  canGoPrev,
  canGoNext,
}: CodingPanelProps) {
  const [appliedTagIds, setAppliedTagIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [customTagName, setCustomTagName] = useState("");
  const [creatingTag, setCreatingTag] = useState(false);

  const isBulkMode = bulkSelectedDocumentIds.length > 0;

  useEffect(() => {
    if (isBulkMode) return;
    api
      .getDocumentTags(matterId, documentId)
      .then(setAppliedTagIds)
      .catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterId, documentId, isBulkMode]);

  async function toggleTag(tagId: string) {
    try {
      if (isBulkMode) {
        // No meaningful "on" state across N documents with mixed existing
        // tags — every click here means "apply to all N," never toggle-
        // off. Selection is deliberately not cleared afterward, so a
        // second code can be applied to the same batch immediately.
        await api.applyTag(matterId, bulkSelectedDocumentIds, tagId);
        onTagsChanged();
        return;
      }
      const isApplied = appliedTagIds.includes(tagId);
      if (isApplied) {
        await api.removeTag(matterId, [documentId], tagId);
        setAppliedTagIds((ids) => ids.filter((id) => id !== tagId));
      } else {
        await api.applyTag(matterId, [documentId], tagId);
        setAppliedTagIds((ids) => [...ids, tagId]);
      }
      onTagsChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCreateCustomTag() {
    const name = customTagName.trim();
    if (!name) return;
    setCreatingTag(true);
    try {
      await api.createCustomTag(matterId, name);
      setCustomTagName("");
      onTagsChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingTag(false);
    }
  }

  return (
    <div className="split-pane">
      <div className="pane-title-row">
        <h2 className="panel-title">{isBulkMode ? `Applying to ${bulkSelectedDocumentIds.length} selected document${bulkSelectedDocumentIds.length === 1 ? "" : "s"}` : "Coding"}</h2>
        {isBulkMode ? (
          <button type="button" className="pop-out-btn" onClick={onClearBulkSelection}>
            Clear selection
          </button>
        ) : (
          <div className="doc-nav-btns">
            <button type="button" className="pop-out-btn" disabled={!canGoPrev} onClick={onPrev}>
              ‹ Prev
            </button>
            <button type="button" className="pop-out-btn" disabled={!canGoNext} onClick={onNext}>
              Next ›
            </button>
          </div>
        )}
      </div>
      <div className="panel-body">
        {error && <p className="preview-unsupported">{error}</p>}
        {!error &&
          tagSets.map((tagSet) => (
            <div key={tagSet.id} className="section">
              <h2 className="panel-title">{tagSet.name}</h2>
              <div className="tag-toggle-grid">
                {tagSet.tags.map((tag) => {
                  const isApplied = !isBulkMode && appliedTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className={`tag-toggle${isApplied ? " on" : ""}`}
                      onClick={() => toggleTag(tag.id)}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        {!error && tagSets.length === 0 && <p className="empty-note">No tag sets configured for this matter.</p>}
        <div className="section">
          <h2 className="panel-title">Custom code</h2>
          <div className="custom-tag-row">
            <input
              className="search-box"
              placeholder="New code name…"
              value={customTagName}
              onChange={(e) => setCustomTagName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateCustomTag()}
            />
            <button type="button" className="pop-out-btn" disabled={!customTagName.trim() || creatingTag} onClick={handleCreateCustomTag}>
              {creatingTag ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
