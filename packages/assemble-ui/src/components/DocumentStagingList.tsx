import { useEffect, useState } from "react";
import type { BundleDTO, DocumentDTO, TabDTO } from "../types";

interface Props {
  documents: DocumentDTO[];
  bundles: BundleDTO[];
  onAssignMany: (documentIds: string[], tabId: string) => void;
  onRemove: (documentId: string) => void;
  onRemoveMany: (documentIds: string[]) => void;
}

/** Every tab at every depth under one bundle, flattened for the <select> — a nested sub-tab is indented (via "— " repeated per level) so its nesting is still visible in a flat dropdown list. */
function flattenTabOptions(tabs: TabDTO[], depth: number): { id: string; label: string }[] {
  return tabs.flatMap((tab) => [
    { id: tab.id, label: `${"— ".repeat(depth)}${tab.title || "(untitled tab)"}` },
    ...flattenTabOptions(tab.tabs, depth + 1),
  ]);
}

function tabOptionsHtml(bundles: BundleDTO[]) {
  return bundles.map((bundle) => (
    <optgroup key={bundle.id} label={bundle.title || "(untitled bundle)"}>
      {flattenTabOptions(bundle.tabs, 0).map((opt) => (
        <option key={opt.id} value={opt.id}>
          {opt.label}
        </option>
      ))}
    </optgroup>
  ));
}

export function DocumentStagingList({ documents, bundles, onAssignMany, onRemove, onRemoveMany }: Props) {
  const hasTabs = bundles.some((b) => b.tabs.length > 0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [targetTabId, setTargetTabId] = useState("");

  // Drops any selected id that's no longer in the staging list (moved via
  // this same action, removed, or the assembly changed elsewhere) — without
  // this, a stale id could silently ride along into a later bulk move.
  useEffect(() => {
    setSelectedIds((prev) => {
      const stillPresent = new Set(documents.map((d) => d.id));
      const next = new Set([...prev].filter((id) => stillPresent.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [documents]);

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds((prev) => (prev.size === documents.length ? new Set() : new Set(documents.map((d) => d.id))));
  }

  function handleMoveSelected() {
    if (selectedIds.size === 0 || !targetTabId) return;
    onAssignMany([...selectedIds], targetTabId);
    setSelectedIds(new Set());
    setTargetTabId("");
  }

  function handleRemoveSelected() {
    if (selectedIds.size === 0) return;
    onRemoveMany([...selectedIds]);
    setSelectedIds(new Set());
  }

  return (
    <div className="staging-list">
      <h2>Staging ({documents.length})</h2>
      {documents.length === 0 && <p className="muted">No unplaced documents.</p>}
      {documents.length > 0 && (
        <div className="staging-list__bulk-bar">
          <label className="staging-list__select-all">
            <input
              type="checkbox"
              checked={selectedIds.size > 0 && selectedIds.size === documents.length}
              onChange={toggleAll}
            />
            Select all
          </label>
          <select value={targetTabId} disabled={!hasTabs} onChange={(e) => setTargetTabId(e.target.value)}>
            <option value="" disabled>
              {hasTabs ? "Move to tab…" : "No tabs yet"}
            </option>
            {tabOptionsHtml(bundles)}
          </select>
          <button className="small" disabled={selectedIds.size === 0 || !targetTabId} onClick={handleMoveSelected}>
            Move {selectedIds.size || ""} selected
          </button>
          <button className="small danger" disabled={selectedIds.size === 0} onClick={handleRemoveSelected}>
            Remove {selectedIds.size || ""} selected
          </button>
        </div>
      )}
      <ul>
        {documents.map((doc) => (
          <li key={doc.id} className="staging-list__item">
            <input
              type="checkbox"
              className="staging-list__checkbox"
              checked={selectedIds.has(doc.id)}
              onChange={() => toggleOne(doc.id)}
            />
            <div className="staging-list__body">
              <div className="staging-list__title">
                {doc.title}
                {doc.date && <span className="muted"> — {doc.date}</span>}
              </div>
              <div className="staging-list__meta">{doc.pageCount}p</div>
            </div>
            <button onClick={() => onRemove(doc.id)} title="Remove document">
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
