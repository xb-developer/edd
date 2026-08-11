import { useCallback, useEffect, useRef, useState } from "react";
import { useBoundApi } from "../useCloudApi";
import type { DocumentSummary, Matter, Tag } from "../types";
import { UploadDropzone } from "./UploadDropzone";
import { DocumentPreview } from "./DocumentPreview";
import { AskPanel } from "./AskPanel";

interface Props {
  matter: Matter;
  onSwitchMatter: () => void;
}

function formatSize(bytes: string | number): string {
  const n = typeof bytes === "string" ? Number(bytes) : bytes;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_LABEL: Record<DocumentSummary["status"], string> = {
  pending_extraction: "Processing…",
  extracted: "Ready",
  extraction_failed: "Failed",
};

export function DocumentRegister({ matter, onSwitchMatter }: Props) {
  const api = useBoundApi();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orgTags, setOrgTags] = useState<Tag[]>([]);
  const [showAsk, setShowAsk] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = query.trim() ? await api.searchDocuments(matter.id, query.trim()) : await api.listDocuments(matter.id);
      setDocuments(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matter.id, query]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    api.listTags().then(setOrgTags).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll while anything is still processing — extraction/embedding happen
  // asynchronously server-side (Section 3.4), so the status shown here isn't
  // final the moment upload responds.
  useEffect(() => {
    const anyPending = documents.some((d) => d.status === "pending_extraction");
    if (anyPending && !pollRef.current) {
      pollRef.current = setInterval(refresh, 3000);
    } else if (!anyPending && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [documents, refresh]);

  async function handleUpload(files: FileList) {
    setUploadErrors([]);
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const doc = await api.uploadDocument(matter.id, file);
        setDocuments((prev) => [...prev, doc]);
      } catch (err) {
        // Accumulated across the whole batch rather than overwritten per
        // file, so uploading several files and having one fail doesn't hide
        // that failure behind whichever file happens to finish last.
        failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) setUploadErrors(failures);
  }

  const selected = documents.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="register-shell">
      <div className="register-header">
        <div>
          <h1>{matter.name}</h1>
          <button className="link-button" onClick={onSwitchMatter}>
            Switch matter
          </button>
        </div>
        <div className="register-actions">
          <input
            type="search"
            placeholder="Search documents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button onClick={() => setShowAsk((v) => !v)}>{showAsk ? "Hide Ask" : "Ask"}</button>
        </div>
      </div>

      <UploadDropzone onFiles={handleUpload} />
      <p className="muted upload-hint">
        Very large files (over 2GB) can take a while and may fail depending on your network connection — if a
        large upload fails, please try again.
      </p>

      {error && <p className="error-text">{error}</p>}
      {uploadErrors.length > 0 && (
        <div className="error-text upload-errors">
          {uploadErrors.map((message, i) => (
            <p key={i}>{message}</p>
          ))}
        </div>
      )}

      <div className="register-body">
        <div className="register-table-wrap">
          {loading ? (
            <p>Loading…</p>
          ) : documents.length === 0 ? (
            <p className="muted">No documents yet — drag files onto the box above to upload.</p>
          ) : (
            <table className="register-table">
              <thead>
                <tr>
                  <th>GUID</th>
                  <th>Filename</th>
                  <th>Status</th>
                  <th>Size</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr
                    key={doc.id}
                    className={doc.id === selectedId ? "selected" : undefined}
                    onClick={() => setSelectedId(doc.id)}
                  >
                    <td className="mono">{doc.guid}</td>
                    <td>{doc.filename}</td>
                    <td>
                      <span className={`status-pill status-${doc.status}`}>{STATUS_LABEL[doc.status]}</span>
                    </td>
                    <td>{formatSize(doc.size_bytes)}</td>
                    <td>
                      <TagCell
                        doc={doc}
                        orgTags={orgTags}
                        onOrgTagsChange={setOrgTags}
                        onDocumentTagsChange={(tags) =>
                          setDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, tags } : d)))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selected && <DocumentPreview documentId={selected.id} />}
        {showAsk && <AskPanel matterId={matter.id} onSelectDocumentId={setSelectedId} />}
      </div>
    </div>
  );
}

function TagCell({
  doc,
  orgTags,
  onOrgTagsChange,
  onDocumentTagsChange,
}: {
  doc: DocumentSummary;
  orgTags: Tag[];
  onOrgTagsChange: (tags: Tag[]) => void;
  onDocumentTagsChange: (tags: Tag[]) => void;
}) {
  const api = useBoundApi();
  const [adding, setAdding] = useState(false);

  async function addExisting(tagId: string) {
    await api.applyTag(doc.id, tagId);
    const tag = orgTags.find((t) => t.id === tagId);
    if (tag) onDocumentTagsChange([...doc.tags, tag]);
    setAdding(false);
  }

  async function createAndAdd(name: string) {
    const tag = await api.createTag(name);
    onOrgTagsChange([...orgTags, tag]);
    await api.applyTag(doc.id, tag.id);
    onDocumentTagsChange([...doc.tags, tag]);
    setAdding(false);
  }

  async function remove(tagId: string) {
    await api.removeTag(doc.id, tagId);
    onDocumentTagsChange(doc.tags.filter((t) => t.id !== tagId));
  }

  return (
    <div className="tag-cell" onClick={(e) => e.stopPropagation()}>
      {doc.tags.map((t) => (
        <span key={t.id} className="tag-pill" style={t.color ? { background: t.color } : undefined}>
          {t.name}
          <button className="tag-remove" onClick={() => remove(t.id)} aria-label={`Remove ${t.name}`}>
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <TagPicker orgTags={orgTags} existingIds={doc.tags.map((t) => t.id)} onPick={addExisting} onCreate={createAndAdd} onCancel={() => setAdding(false)} />
      ) : (
        <button className="tag-add" onClick={() => setAdding(true)}>
          + tag
        </button>
      )}
    </div>
  );
}

function TagPicker({
  orgTags,
  existingIds,
  onPick,
  onCreate,
  onCancel,
}: {
  orgTags: Tag[];
  existingIds: string[];
  onPick: (tagId: string) => void;
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const available = orgTags.filter((t) => !existingIds.includes(t.id));
  const exactMatch = available.find((t) => t.name.toLowerCase() === value.trim().toLowerCase());

  return (
    <span className="tag-picker">
      <input
        autoFocus
        list="org-tags"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && value.trim()) {
            e.preventDefault();
            exactMatch ? onPick(exactMatch.id) : onCreate(value.trim());
          }
        }}
        onBlur={onCancel}
        placeholder="tag name"
      />
      <datalist id="org-tags">
        {available.map((t) => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
    </span>
  );
}
