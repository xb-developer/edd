import { useState } from "react";
import type { DocumentDTO, Tag } from "../types";

interface Props {
  targets: DocumentDTO[];
  tags: Tag[];
  onToggleTag: (tag: Tag, turnOn: boolean) => void;
  onCreateTag: (name: string) => void;
  onPrevDocument: () => void;
  onNextDocument: () => void;
  canGoPrevDocument: boolean;
  canGoNextDocument: boolean;
}

const CUSTOM_PALETTE = ["#1F6C8C", "#5A45A8", "#B4551F", "#3F7D2C", "#B03362"];

export function tagColorFor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CUSTOM_PALETTE[h % CUSTOM_PALETTE.length];
}

export function CodingPanel({
  targets,
  tags,
  onToggleTag,
  onCreateTag,
  onPrevDocument,
  onNextDocument,
  canGoPrevDocument,
  canGoNextDocument,
}: Props) {
  const [customName, setCustomName] = useState("");

  // Shared with both the empty and populated states below so the arrows
  // stay available (just disabled at either end of the list) regardless of
  // whether anything is currently selected for tagging.
  const titleRow = (
    <div className="pane-title-row">
      <h3 className="pane-title">Coding</h3>
      <div className="doc-nav-btns">
        <button className="pop-out-btn" onClick={onPrevDocument} disabled={!canGoPrevDocument} title="Previous document">
          ‹ Prev
        </button>
        <button className="pop-out-btn" onClick={onNextDocument} disabled={!canGoNextDocument} title="Next document">
          Next ›
        </button>
      </div>
    </div>
  );

  if (targets.length === 0) {
    return (
      <div className="split-pane">
        {titleRow}
        <div className="panel-body">
          <div className="no-selection">Select a document (or check several) to apply tags.</div>
        </div>
      </div>
    );
  }

  const submitCustom = () => {
    const name = customName.trim();
    if (!name) return;
    onCreateTag(name);
    setCustomName("");
  };

  return (
    <div className="split-pane">
      {titleRow}
      <div className="panel-body">
        <div className="coding-ref">
          <span className="guid-badge-sm">{targets.length === 1 ? targets[0].guid : `${targets.length} docs`}</span>
          <span className="ref-name">{targets.length === 1 ? targets[0].originalName : "Bulk tagging"}</span>
        </div>

        {targets.length > 1 && (
          <div className="bulk-note">
            Applying tags to {targets.length} checked documents. A tag shows as active only if every checked
            document already has it.
          </div>
        )}

        <div className="tag-toggle-grid">
          {tags.map((t) => {
            const allHave = targets.every((d) => d.tags.some((dt) => dt.id === t.id));
            return (
              <button
                key={t.id}
                className={`tag-toggle${allHave ? " on" : ""}`}
                style={allHave ? { background: t.color } : undefined}
                onClick={() => onToggleTag(t, !allHave)}
              >
                {t.name}
              </button>
            );
          })}
        </div>

        <div className="custom-tag-row">
          <input
            placeholder="Custom tag…"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitCustom()}
          />
          <button onClick={submitCustom}>+</button>
        </div>
      </div>
    </div>
  );
}
