import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Space } from "antd";
import type { ApiClient } from "./api";
import type { TagSetDTO } from "./types";

export interface CodingPanelProps {
  api: ApiClient;
  matterId: string;
  documentId: string;
  /**
   * Independent of `documentId` — the bulk-select checkbox column's checked
   * ids. Non-empty switches the whole panel into bulk-apply mode;
   * `documentId` (the single-preview target) is ignored while that's true.
   *
   * The Set itself, NOT a fresh `Array.from(...)` per render: a new array
   * every render changes identity every render, which would silently defeat
   * `bulkAppliedCountByTagId`'s memo below.
   */
  bulkSelectedDocumentIds: ReadonlySet<string>;
  onClearBulkSelection: () => void;
  /** Lifted to MatterDetail (shared with the results table's own tag chips) — needed here so bulk mode can invert each selected document's OWN current state for a tag, not force every document to the same state. */
  appliedTagsByDocument: Record<string, string[]>;
  /** Lifted to MatterDetail (shared with FilterPanel's tag filter, avoiding a duplicate fetch) rather than fetched here. */
  tagSets: TagSetDTO[];
  /** Called after a tag is applied/removed, or a custom code is created, so FilterPanel's tag-filter counts/options and tagSets stay live. */
  onTagsChanged: () => void;
  /** Walks the matter's (already server-ordered) document list — same selection state that also drives the docked/popped-out viewer, so Prev/Next updates whichever one is active. */
  onPrev: () => void;
  onNext: () => void;
  canGoPrev: boolean;
  canGoNext: boolean;
  /** viewerWindow.focusPopout — every button here is a click inside the main window, which would otherwise drop an open pop-out behind it (see useViewerWindow's doc comment); call before each action, same as MatterDetail's row/checkbox handlers. */
  onFocusPopout: () => void;
}

// Tag toggles are deliberately NOT antd Buttons: they have three states, and
// antd's Button has no notion of "partially applied". Styling is Tailwind;
// only the state logic lives in the component.
const TAG_TOGGLE_BASE = "rounded-[14px] border px-2.5 py-[5px] text-xs font-semibold transition-colors";
const TAG_TOGGLE_STATE = {
  // Deliberately the same light blue for every tag regardless of that tag's
  // own configured colour (still used as an identification swatch in
  // FilterPanel's tag-dot and the table's chips) — "applied" is not meant to
  // double as a per-tag colour code.
  on: "border-[#a9cdf5] bg-[#d3e6fb] text-navy",
  // Bulk mode only: some but not all of the checked documents already have
  // this code. Dashed on a paler fill, so it reads as "partially applied"
  // rather than "applied" — the next click still inverts each document's own
  // state rather than applying uniformly.
  mixed: "border-dashed border-[#a9cdf5] bg-[#eef6fe] text-navy",
  off: "border-line bg-panel text-ink-soft hover:border-ink-soft",
} as const;

// Scaffolded ahead of the coding/tagging backend originally (see api.ts's
// history) — now backed by a real matter-scoped schema (tag_sets/tags/
// document_tags).
export function CodingPanel({
  api,
  matterId,
  documentId,
  bulkSelectedDocumentIds,
  onClearBulkSelection,
  appliedTagsByDocument,
  tagSets,
  onTagsChanged,
  onPrev,
  onNext,
  canGoPrev,
  canGoNext,
  onFocusPopout,
}: CodingPanelProps) {
  const [appliedTagIds, setAppliedTagIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [customTagName, setCustomTagName] = useState("");
  const [creatingTag, setCreatingTag] = useState(false);

  const isBulkMode = bulkSelectedDocumentIds.size > 0;

  // One pass over the checked documents building tagId → count, rather than
  // re-filtering the whole selection inside the tag render loop below once
  // per tag — that was O(tags × checked) on EVERY render (50 codes × 5,000
  // checked documents ≈ 250,000 comparisons), not just when either changed.
  const bulkAppliedCountByTagId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of bulkSelectedDocumentIds) {
      for (const tagId of appliedTagsByDocument[id] ?? []) counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    }
    return counts;
  }, [bulkSelectedDocumentIds, appliedTagsByDocument]);

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
        // A true per-document invert, not "force every selected document
        // to the same state" — a document that already has this code loses
        // it, one that doesn't gains it, even within the same click on a
        // batch with mixed existing state. Selection is deliberately not
        // cleared afterward, so a second code can be applied to the same
        // batch immediately.
        const toRemove: string[] = [];
        const toApply: string[] = [];
        for (const id of bulkSelectedDocumentIds) {
          ((appliedTagsByDocument[id] ?? []).includes(tagId) ? toRemove : toApply).push(id);
        }
        await Promise.all([
          toRemove.length > 0 ? api.removeTag(matterId, toRemove, tagId) : null,
          toApply.length > 0 ? api.applyTag(matterId, toApply, tagId) : null,
        ]);
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
    <div className="flex min-h-[60px] flex-1 flex-col overflow-hidden">
      <div className="flex flex-none items-center justify-between gap-2 border-b border-line bg-panel px-4 pt-2.5 pb-[9px]">
        <h2 className="m-0 mb-2.5 text-xs font-semibold tracking-[0.08em] text-ink-soft uppercase">{isBulkMode ? `Applying to ${bulkSelectedDocumentIds.size} selected document${bulkSelectedDocumentIds.size === 1 ? "" : "s"}` : "Coding"}</h2>
        {isBulkMode ? (
          <Button
            size="small"
            onClick={() => {
              onFocusPopout();
              onClearBulkSelection();
            }}
          >
            Clear selection
          </Button>
        ) : (
          <Space.Compact size="small">
            <Button
              disabled={!canGoPrev}
              onClick={() => {
                onFocusPopout();
                onPrev();
              }}
            >
              ‹ Prev
            </Button>
            <Button
              disabled={!canGoNext}
              onClick={() => {
                onFocusPopout();
                onNext();
              }}
            >
              Next ›
            </Button>
          </Space.Compact>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && <Alert type="error" showIcon className="mb-2" message={error} />}
        {!error &&
          tagSets.map((tagSet) => (
            <div key={tagSet.id} className="mb-6">
              <h2 className="m-0 mb-2.5 text-xs font-semibold tracking-[0.08em] text-ink-soft uppercase">{tagSet.name}</h2>
              <div className="mb-3.5 flex flex-wrap gap-1.5">
                {tagSet.tags.map((tag) => {
                  if (!isBulkMode) {
                    const isApplied = appliedTagIds.includes(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        className={`${TAG_TOGGLE_BASE} ${isApplied ? TAG_TOGGLE_STATE.on : TAG_TOGGLE_STATE.off}`}
                        onClick={() => {
                          onFocusPopout();
                          toggleTag(tag.id);
                        }}
                      >
                        {tag.name}
                      </button>
                    );
                  }
                  // Bulk mode's own three states — not just on/off — since a
                  // click here inverts each selected document's own current
                  // state rather than forcing them all the same way; "mixed"
                  // (some but not all of the batch already has this code)
                  // needs to look visibly different from a clean "none of
                  // them do" so the click's real effect isn't a surprise.
                  const appliedCount = bulkAppliedCountByTagId.get(tag.id) ?? 0;
                  const bulkState = appliedCount === 0 ? "off" : appliedCount === bulkSelectedDocumentIds.size ? "on" : "mixed";
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className={`${TAG_TOGGLE_BASE} ${TAG_TOGGLE_STATE[bulkState]}`}
                      onClick={() => {
                        onFocusPopout();
                        toggleTag(tag.id);
                      }}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        {!error && tagSets.length === 0 && <p className="px-0.5 py-1 text-xs italic text-ink-soft">No tag sets configured for this matter.</p>}
        <div className="mb-6">
          <h2 className="m-0 mb-2.5 text-xs font-semibold tracking-[0.08em] text-ink-soft uppercase">Custom code</h2>
          <Space.Compact size="small" className="w-full">
            <Input
              placeholder="New code name…"
              value={customTagName}
              onChange={(e) => setCustomTagName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onFocusPopout();
                  handleCreateCustomTag();
                }
              }}
            />
            <Button
              disabled={!customTagName.trim()}
              loading={creatingTag}
              onClick={() => {
                onFocusPopout();
                handleCreateCustomTag();
              }}
            >
              Add
            </Button>
          </Space.Compact>
        </div>
      </div>
    </div>
  );
}
