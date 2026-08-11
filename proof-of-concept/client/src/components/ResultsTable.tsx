import type { DocumentDTO } from "../types";
import { formatDate, formatSize } from "../lib/format";
import { displayName } from "../lib/displayName";

export type SortKey =
  | "guid"
  | "familyId"
  | "originalName"
  | "extension"
  | "sizeBytes"
  | "dateCreated"
  | "dateModified"
  | "author"
  | "to"
  | "cc";

interface Props {
  documents: DocumentDTO[];
  selectedGuid: string | null;
  checkedGuids: Set<string>;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSelect: (guid: string) => void;
  onToggleCheck: (guid: string) => void;
  onToggleCheckAll: (checked: boolean) => void;
  onSort: (key: SortKey) => void;
  onDelete: (guid: string) => void;
}

const COLUMNS: Array<{ key: SortKey; label: string; width: number }> = [
  { key: "guid", label: "GUID", width: 90 },
  { key: "familyId", label: "Family GUID", width: 100 },
  { key: "originalName", label: "Filename", width: 240 },
  { key: "extension", label: "Type", width: 60 },
  { key: "sizeBytes", label: "Size", width: 80 },
  { key: "dateCreated", label: "Date", width: 150 },
  { key: "dateModified", label: "Date modified", width: 150 },
  { key: "author", label: "Author", width: 130 },
  { key: "to", label: "To", width: 160 },
  { key: "cc", label: "Cc", width: 160 },
];

export function ResultsTable({
  documents,
  selectedGuid,
  checkedGuids,
  sortKey,
  sortDir,
  onSelect,
  onToggleCheck,
  onToggleCheckAll,
  onSort,
  onDelete,
}: Props) {
  if (documents.length === 0) {
    return (
      <div className="empty-state">
        <div className="glyph">000000</div>
        <h3>No documents in the register</h3>
        <p>Import a set of files to assign each one a GUID, extract its file properties, and start coding and filtering.</p>
      </div>
    );
  }

  const allChecked = documents.length > 0 && documents.every((d) => checkedGuids.has(d.guid));

  return (
    <table className="reg">
      <colgroup>
        <col style={{ width: 32 }} />
        {COLUMNS.map((c) => (
          <col key={c.key} style={{ width: c.width }} />
        ))}
        <col style={{ width: 200 }} />
        <col style={{ width: 32 }} />
      </colgroup>
      <thead>
        <tr>
          <th className="checkcell">
            <input type="checkbox" checked={allChecked} onChange={(e) => onToggleCheckAll(e.target.checked)} />
          </th>
          {COLUMNS.map((c) => (
            <th key={c.key} className={sortKey === c.key ? "sorted" : ""} onClick={() => onSort(c.key)}>
              {c.label}
              {sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
            </th>
          ))}
          <th>Tags</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {documents.map((doc) => (
          <tr
            key={doc.guid}
            className={doc.guid === selectedGuid ? "active" : ""}
            onClick={() => onSelect(doc.guid)}
          >
            <td className="checkcell" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={checkedGuids.has(doc.guid)}
                onChange={() => onToggleCheck(doc.guid)}
              />
            </td>
            <td className="guid">{doc.guid}</td>
            <td className="guid">{doc.familyId}</td>
            <td className="fname" title={doc.depth > 0 ? `Attached to ${doc.parentGuid}` : doc.originalName} style={doc.depth > 0 ? { paddingLeft: 10 + doc.depth * 16 } : undefined}>
              {doc.depth > 0 && <span className="muted">↳ </span>}
              {displayName(doc)}
            </td>
            <td className="muted">{doc.extension || "—"}</td>
            <td className="muted">{formatSize(doc.sizeBytes)}</td>
            <td className="muted">{formatDate(doc.dateCreated)}</td>
            <td className="muted">{formatDate(doc.dateModified)}</td>
            <td>{doc.author || <span className="muted">—</span>}</td>
            <td>{doc.to || <span className="muted">—</span>}</td>
            <td>{doc.cc || <span className="muted">—</span>}</td>
            <td>
              <div className="tagchips">
                {doc.tags.map((t) => (
                  <span key={t.id} className="chip" style={{ background: `${t.color}22`, color: t.color }}>
                    {t.name}
                  </span>
                ))}
              </div>
            </td>
            <td onClick={(e) => e.stopPropagation()}>
              <button className="row-delete-btn" title="Delete document" onClick={() => onDelete(doc.guid)}>
                ×
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
