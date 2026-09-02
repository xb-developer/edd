import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { ApiClient } from "./api";
import type { TagSetDTO, MatterMemberDTO, MatterMemberCandidateDTO, DocumentDTO } from "./types";
import { ExportButtons } from "./ExportButtons";
import { RetryIngestButton } from "./RetryIngestButton";

export type IngestStatusFilter = DocumentDTO["ingestStatus"] | "all";

const STATUS_FILTER_OPTIONS: { value: IngestStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "ready", label: "Ready" },
  { value: "failed", label: "Failed" },
];

export interface FilterPanelProps {
  api: ApiClient;
  matterId: string;
  /** Admin, or this matter's own creator — only they may add/remove entries; anyone with access can still view the list. */
  canManageAccess: boolean;
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
  /** The matter's full, unfiltered document list — needed here (not just the already-filtered rows the table shows) so status counts reflect the whole matter, same as tag counts already do via appliedTagsByDocument. */
  documents: DocumentDTO[];
  statusFilter: IngestStatusFilter;
  onStatusFilterChange: (status: IngestStatusFilter) => void;
  /** Called after a successful retry-ingest so the caller re-fetches the document list. */
  onDocumentsChanged: () => void;
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
  canManageAccess,
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
  documents,
  statusFilter,
  onStatusFilterChange,
  onDocumentsChanged,
}: FilterPanelProps) {
  const allTags = tagSets.flatMap((tagSet) => tagSet.tags);
  const countForTag = (tagId: string) => Object.values(appliedTagsByDocument).filter((tagIds) => tagIds.includes(tagId)).length;
  const countForStatus = (status: DocumentDTO["ingestStatus"]) => documents.filter((d) => d.ingestStatus === status).length;
  // Retry only ever sends genuinely-failed ids — a broader multi-select
  // (e.g. spanning failed + ready) silently narrows to just the failed
  // ones rather than 400ing the whole request, since the server enforces
  // "every id must be failed" as a real safety check, not a UX hint.
  const failedSelectedDocumentIds = documents.filter((d) => selectedDocumentIds.includes(d.documentId) && d.ingestStatus === "failed").map((d) => d.documentId);

  const [members, setMembers] = useState<MatterMemberDTO[] | null>(null);
  const [candidates, setCandidates] = useState<MatterMemberCandidateDTO[] | null>(null);
  const [addingRow, setAddingRow] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  function refreshMembers() {
    api.getMatterMembers(matterId).then(setMembers).catch((err) => setAccessError(err.message));
  }

  useEffect(() => {
    setMembers(null);
    setAddingRow(false);
    setCandidates(null);
    refreshMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterId]);

  function openAddRow() {
    setAddingRow(true);
    setAccessError(null);
    api
      .getMatterMemberCandidates(matterId)
      .then(setCandidates)
      .catch((err) => {
        // Without this, a failed fetch left the row stuck showing a
        // permanently-disabled "Loading…" select with no way out — the
        // error is shown, but the UI must also fall back to the "+"
        // button rather than hanging in a dead state forever.
        setAccessError(err.message);
        setAddingRow(false);
      });
  }

  async function handleAddMember(candidate: MatterMemberCandidateDTO) {
    setBusyUserId(candidate.auth0UserId);
    try {
      setAccessError(null);
      await api.addMatterMember(matterId, candidate);
      setAddingRow(false);
      refreshMembers();
    } catch (err) {
      setAccessError((err as Error).message);
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleRemoveMember(member: MatterMemberDTO) {
    setBusyUserId(member.userId);
    try {
      setAccessError(null);
      await api.removeMatterMember(matterId, member.userId);
      refreshMembers();
    } catch (err) {
      setAccessError((err as Error).message);
    } finally {
      setBusyUserId(null);
    }
  }

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

      <div className="section">
        <h2 className="panel-title">Processing</h2>
        <select
          className="search-box"
          aria-label="Filter by processing status"
          value={statusFilter}
          onChange={(e) => onStatusFilterChange(e.target.value as IngestStatusFilter)}
        >
          {STATUS_FILTER_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label} ({value === "all" ? documents.length : countForStatus(value)})
            </option>
          ))}
        </select>
        <RetryIngestButton api={api} matterId={matterId} documentIds={failedSelectedDocumentIds} onRetried={onDocumentsChanged} />
        <p className="export-hint">
          {failedSelectedDocumentIds.length === 0
            ? "Check failed documents in the table to enable retry."
            : `Retries ingest for the ${failedSelectedDocumentIds.length} currently checked failed document${failedSelectedDocumentIds.length === 1 ? "" : "s"}.`}
        </p>
      </div>

      <div className="section">
        <h2 className="panel-title">Access</h2>
        {accessError && <p className="bulk-note">{accessError}</p>}
        {!members ? (
          <p className="empty-note">Loading…</p>
        ) : (
          <table className="access-list">
            <tbody>
              {members.map((member) => (
                <tr key={member.userId}>
                  <td className="access-list-name">{member.name ?? member.email}</td>
                  {canManageAccess && (
                    <td className="access-list-remove">
                      <button
                        type="button"
                        className="access-list-remove-btn"
                        aria-label={`Remove ${member.email}`}
                        disabled={busyUserId === member.userId}
                        onClick={() => handleRemoveMember(member)}
                      >
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {canManageAccess &&
                (addingRow ? (
                  <tr>
                    <td colSpan={2}>
                      <select
                        className="access-list-select"
                        autoFocus
                        defaultValue=""
                        disabled={!candidates || busyUserId !== null}
                        onChange={(e) => {
                          const candidate = candidates?.find((c) => c.auth0UserId === e.target.value);
                          if (candidate) handleAddMember(candidate);
                        }}
                        onBlur={() => setAddingRow(false)}
                      >
                        <option value="" disabled>
                          {candidates === null ? "Loading…" : candidates.length === 0 ? "No eligible users" : "Select a user…"}
                        </option>
                        {candidates?.map((c) => (
                          <option key={c.auth0UserId} value={c.auth0UserId}>
                            {c.name ?? c.email}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ) : (
                  <tr>
                    <td colSpan={2}>
                      <button type="button" className="access-list-add-btn" aria-label="Add a user to this matter's access list" onClick={openAddRow}>
                        +
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
