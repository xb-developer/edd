import { useState } from "react";
import type { BundleDTO } from "../types";
import { TabCard, type TabCardHandlers } from "./TabCard";

interface Props extends TabCardHandlers {
  bundles: BundleDTO[];
  onAddBundle: (label: string) => void;
  onDeleteBundle: (id: string) => void;
  onAddTab: (bundleId: string, title: string) => void;
  onUpdateBundleTitle: (bundleId: string, title: string) => void;
  onUpdateBundleLabel: (bundleId: string, label: string) => void;
}

function AddBundleForm({ onAdd }: { onAdd: (label: string) => void }) {
  const [label, setLabel] = useState("");
  return (
    <form
      className="add-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd(label.trim());
        setLabel("");
      }}
    >
      <input
        type="text"
        placeholder="New bundle letter/name (e.g. A)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <button type="submit">Add Bundle</button>
    </form>
  );
}

function AddTabForm({ onAdd }: { onAdd: (title: string) => void }) {
  const [title, setTitle] = useState("");
  return (
    <form
      className="add-inline-form add-inline-form--small"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onAdd(title.trim());
        setTitle("");
      }}
    >
      <input type="text" placeholder="New tab name" value={title} onChange={(e) => setTitle(e.target.value)} />
      <button type="submit">Add Tab</button>
    </form>
  );
}

interface BundleTitleInputProps {
  title: string;
  onUpdate: (title: string) => void;
}

function BundleTitleInput({ title: savedTitle, onUpdate }: BundleTitleInputProps) {
  const [title, setTitle] = useState(savedTitle);

  function commit() {
    const trimmed = title.trim();
    if (trimmed && trimmed !== savedTitle) onUpdate(trimmed);
    else setTitle(savedTitle);
  }

  return (
    <input
      type="text"
      className="bundle-title-input"
      value={title}
      placeholder="(untitled bundle)"
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

interface BundleLabelInputProps {
  label: string;
  onUpdate: (label: string) => void;
}

// Unlike the title, an empty label is a valid, meaningful value — it means
// "flat/untitled bundle", producing bare page numbers ("page 2") instead of
// a lettered prefix ("page A-2"), so empty commits are allowed here (title's
// commit() deliberately rejects empty and reverts instead).
function BundleLabelInput({ label: savedLabel, onUpdate }: BundleLabelInputProps) {
  const [label, setLabel] = useState(savedLabel);

  function commit() {
    if (label !== savedLabel) onUpdate(label);
  }

  return (
    <input
      type="text"
      className="bundle-label-input"
      value={label}
      placeholder="Label"
      title="Short citation prefix used in page references, e.g. A"
      onChange={(e) => setLabel(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function BundleOrganizer({
  bundles,
  onAddBundle,
  onDeleteBundle,
  onAddTab,
  onDeleteTab,
  onAddSubTab,
  onUnassignDocument,
  onMoveDocument,
  onUpdateDocumentDate,
  onUpdateDocumentTitle,
  onUpdateBundleTitle,
  onUpdateBundleLabel,
}: Props) {
  return (
    <div className="bundle-organizer">
      <div className="bundle-organizer__header">
        <h2>Bundles</h2>
        <AddBundleForm onAdd={onAddBundle} />
      </div>

      {bundles.length === 0 && <p className="muted">No bundles yet — add one to start organizing.</p>}

      {bundles.map((bundle) => (
        <div key={bundle.id} className="bundle-card">
          <div className="bundle-card__header">
            <BundleLabelInput label={bundle.label} onUpdate={(label) => onUpdateBundleLabel(bundle.id, label)} />
            <BundleTitleInput title={bundle.title} onUpdate={(title) => onUpdateBundleTitle(bundle.id, title)} />
            <button className="danger" onClick={() => onDeleteBundle(bundle.id)}>
              Delete Bundle
            </button>
          </div>

          {bundle.tabs.map((tab) => (
            <TabCard
              key={tab.id}
              tab={tab}
              depth={0}
              onDeleteTab={onDeleteTab}
              onAddSubTab={onAddSubTab}
              onUnassignDocument={onUnassignDocument}
              onMoveDocument={onMoveDocument}
              onUpdateDocumentDate={onUpdateDocumentDate}
              onUpdateDocumentTitle={onUpdateDocumentTitle}
            />
          ))}

          <AddTabForm onAdd={(title) => onAddTab(bundle.id, title)} />
        </div>
      ))}
    </div>
  );
}
