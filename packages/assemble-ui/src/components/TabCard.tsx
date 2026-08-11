import { useState } from "react";
import type { DocumentDTO, TabDTO } from "../types";
import { DateEditor } from "./DateEditor";

export interface TabCardHandlers {
  onDeleteTab: (id: string) => void;
  onAddSubTab: (parentTabId: string, title: string) => void;
  onUnassignDocument: (documentId: string) => void;
  onMoveDocument: (documentId: string, direction: "up" | "down", tabDocumentIds: string[]) => void;
  onUpdateDocumentDate: (documentId: string, date: string) => void;
  onUpdateDocumentTitle: (documentId: string, title: string) => void;
}

function AddSubTabForm({ onAdd }: { onAdd: (title: string) => void }) {
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
      <input type="text" placeholder="New sub-tab name" value={title} onChange={(e) => setTitle(e.target.value)} />
      <button type="submit">Add Sub-tab</button>
    </form>
  );
}

interface DocumentRowProps {
  doc: DocumentDTO;
  order: number;
  isFirst: boolean;
  isLast: boolean;
  onMove: (direction: "up" | "down") => void;
  onUnassign: () => void;
  onUpdateDate: (date: string) => void;
  onUpdateTitle: (title: string) => void;
}

function DocumentRow({ doc, order, isFirst, isLast, onMove, onUnassign, onUpdateDate, onUpdateTitle }: DocumentRowProps) {
  const [date, setDate] = useState(doc.date ?? "");
  const [title, setTitle] = useState(doc.title);

  function commitDate(newValue: string) {
    if (newValue !== (doc.date ?? "")) onUpdateDate(newValue);
  }

  function commitTitle() {
    const trimmed = title.trim();
    if (trimmed && trimmed !== doc.title) onUpdateTitle(trimmed);
    else setTitle(doc.title);
  }

  return (
    <div className="tab-card__doc-row">
      <span className="doc-order">{order}.</span>
      <input
        type="text"
        className="doc-title-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <DateEditor value={date} onChange={setDate} onCommit={commitDate} />
      <span className="muted">{doc.pageCount}p</span>
      <button disabled={isFirst} onClick={() => onMove("up")} title="Move up">
        ↑
      </button>
      <button disabled={isLast} onClick={() => onMove("down")} title="Move down">
        ↓
      </button>
      <button onClick={onUnassign} title="Return to staging">
        ↩
      </button>
    </div>
  );
}

/** Either kind of a tab's child, tagged so the merged/interleaved render below can tell them apart. */
type TabChild = { kind: "document"; doc: DocumentDTO } | { kind: "tab"; tab: TabDTO };

/** Merges a tab's own documents and its nested sub-tabs into one list ordered by their shared displayOrder — matches the true interleaved order the export uses, so what's shown here is what actually prints. */
function mergedChildren(tab: TabDTO): TabChild[] {
  const docChildren: (TabChild & { order: number })[] = tab.documents.map((doc) => ({ kind: "document", doc, order: doc.displayOrder }));
  const tabChildren: (TabChild & { order: number })[] = tab.tabs.map((t) => ({ kind: "tab", tab: t, order: t.displayOrder }));
  return [...docChildren, ...tabChildren].sort((a, b) => a.order - b.order);
}

interface TabCardProps extends TabCardHandlers {
  tab: TabDTO;
  /** 0 for a top-level tab directly under a bundle, 1 for a sub-tab nested inside that tab, and so on — controls indentation. */
  depth: number;
}

/** Renders one tab, its own documents, and its nested sub-tabs (recursively, to any depth) — as one interleaved sequence in true displayOrder, so a document that comes after a sub-tab in the export shows after that sub-tab's card here too, not grouped separately. Indented per level so nesting reads visually the same way it prints in the Index. */
export function TabCard({ tab, depth, onDeleteTab, onAddSubTab, onUnassignDocument, onMoveDocument, onUpdateDocumentDate, onUpdateDocumentTitle }: TabCardProps) {
  const docIds = tab.documents.map((d) => d.id);
  const children = mergedChildren(tab);
  let docOrder = 0;

  return (
    <div className="tab-card" style={depth > 0 ? { marginLeft: depth * 20 } : undefined}>
      <div className="tab-card__header">
        <h4>{tab.title || "(untitled tab)"}</h4>
        <button className="danger small" onClick={() => onDeleteTab(tab.id)}>
          Delete Tab
        </button>
      </div>
      {children.length === 0 && <p className="muted small">Nothing in this tab yet.</p>}
      <div className="tab-card__children">
        {children.map((c) => {
          if (c.kind === "document") {
            const doc = c.doc;
            const i = docOrder;
            docOrder += 1;
            return (
              <DocumentRow
                key={doc.id}
                doc={doc}
                order={i + 1}
                isFirst={i === 0}
                isLast={i === docIds.length - 1}
                onMove={(direction) => onMoveDocument(doc.id, direction, docIds)}
                onUnassign={() => onUnassignDocument(doc.id)}
                onUpdateDate={(date) => onUpdateDocumentDate(doc.id, date)}
                onUpdateTitle={(title) => onUpdateDocumentTitle(doc.id, title)}
              />
            );
          }
          return (
            <TabCard
              key={c.tab.id}
              tab={c.tab}
              depth={depth + 1}
              onDeleteTab={onDeleteTab}
              onAddSubTab={onAddSubTab}
              onUnassignDocument={onUnassignDocument}
              onMoveDocument={onMoveDocument}
              onUpdateDocumentDate={onUpdateDocumentDate}
              onUpdateDocumentTitle={onUpdateDocumentTitle}
            />
          );
        })}
      </div>
      <AddSubTabForm onAdd={(title) => onAddSubTab(tab.id, title)} />
    </div>
  );
}
