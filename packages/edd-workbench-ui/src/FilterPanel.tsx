import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { ApiClient } from "./api";
import type { TagSetDTO, MatterMemberDTO, MatterMemberCandidateDTO, DocumentDTO, AskResultDTO } from "./types";
import { ExportButtons } from "./ExportButtons";
import { RetryIngestButton } from "./RetryIngestButton";

// "ocr" is a genuinely different axis from the ingestStatus values above it
// (see DocumentDTO.ocrStatus / migration 029) — it selects documents whose
// OCR actually completed (ocrStatus === "ready"), regardless of their
// overall ingestStatus, rather than being one more ingestStatus value.
export type IngestStatusFilter = DocumentDTO["ingestStatus"] | "all" | "ocr";

const STATUS_FILTER_OPTIONS: { value: IngestStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "ready", label: "Ready" },
  { value: "failed", label: "Failed" },
  { value: "ocr", label: "OCR" },
];

export interface FilterPanelProps {
  api: ApiClient;
  matterId: string;
  /** Admin, or this matter's own creator — only they may add/remove entries; anyone with access can still view the list. */
  canManageAccess: boolean;
  /** The caller's own Auth0 user id — used to find "my own row" in the access list, distinct from canManageAccess (which is about who may remove *anyone*). */
  currentUserId: string;
  /** This matter's `created_by`, so the access list can block the creator from removing their own row (see matterMembers.ts's own DELETE /:userId guard — this is the UI-side mirror of that check, not a replacement for it). */
  matterCreatedBy: string | null;
  style?: CSSProperties;
  tagSets: TagSetDTO[];
  appliedTagsByDocument: Record<string, string[]>;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  /** Set (not thrown) by MatterDetail's debounced search effect on a 503/network failure — falls back to showing the unfiltered list rather than blocking the panel. */
  searchError: string | null;
  /** Both null when there's no active search; otherwise the returned/total hit counts, for the "showing first N of M" truncation note. */
  searchTotalHits: number | null;
  matchingDocumentCount: number | null;
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
  /** Lifts a fresh Ask result up to MatterDetail, which renders it in the right-hand panel below CodingPanel. Called with null to clear. */
  onAskResult: (result: AskResultDTO | null) => void;
}

/**
 * Search + tag filter + export, matching the POC's left-column layout.
 * Search is a real backend query (self-hosted Elasticsearch, boolean/
 * phrase-exact matching — see search.ts/searchClient.ts) scoped to this
 * matter, debounced in MatterDetail; this component only renders the box
 * and any error/truncation note, the actual request lives one level up.
 * Tag filtering is genuinely interactive against the same mocked tag state
 * CodingPanel writes to (see api.ts) — counts and matches update live as
 * tags are toggled elsewhere.
 */
export function FilterPanel({
  api,
  matterId,
  canManageAccess,
  currentUserId,
  matterCreatedBy,
  style,
  tagSets,
  appliedTagsByDocument,
  searchQuery,
  onSearchQueryChange,
  searchError,
  searchTotalHits,
  matchingDocumentCount,
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
  onAskResult,
}: FilterPanelProps) {
  const allTags = tagSets.flatMap((tagSet) => tagSet.tags);
  const countForTag = (tagId: string) => Object.values(appliedTagsByDocument).filter((tagIds) => tagIds.includes(tagId)).length;
  const countForStatus = (status: Exclude<IngestStatusFilter, "all">) =>
    status === "ocr" ? documents.filter((d) => d.ocrStatus === "ready").length : documents.filter((d) => d.ingestStatus === status).length;
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

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  function refreshMembers() {
    api.getMatterMembers(matterId).then(setMembers).catch((err) => setAccessError(err.message));
  }

  useEffect(() => {
    setMembers(null);
    setAddingRow(false);
    setCandidates(null);
    refreshMembers();
    // A stale answer from the previous matter has no meaning here — clear
    // both the question and the lifted-up result the moment the open
    // matter changes.
    setQuestion("");
    setAskError(null);
    onAskResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterId]);

  async function handleAsk() {
    const trimmed = question.trim();
    if (!trimmed) return;
    setAsking(true);
    setAskError(null);
    try {
      const result = await api.askQuestion(matterId, trimmed);
      onAskResult(result);
    } catch (err) {
      setAskError((err as Error).message);
    } finally {
      setAsking(false);
    }
  }

  function handleClearQuestion() {
    setQuestion("");
    setAskError(null);
    onAskResult(null);
  }

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
        <input
          className="search-box"
          placeholder='Search documents… (AND, OR, NOT, "phrase", (grouping))'
          title='Search documents… AND / OR / NOT, ( ) for grouping, "exact phrase", +required, -excluded, * wildcard'
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
        />
        <button type="button" className="pop-out-btn" onClick={() => onSearchQueryChange("")} disabled={!searchQuery}>
          Clear Search
        </button>
        {searchError && <p className="bulk-note">{searchError}</p>}
        {searchTotalHits !== null && matchingDocumentCount !== null && searchTotalHits > matchingDocumentCount && (
          <p className="bulk-note">
            Showing first {matchingDocumentCount} of {searchTotalHits} matches — narrow your search
          </p>
        )}
      </div>

      <div className="section">
        <h2 className="panel-title">Question</h2>
        <textarea
          className="search-box"
          rows={3}
          placeholder="Ask a question about this matter…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        {askError && <p className="bulk-note">{askError}</p>}
        <div className="ask-row">
          <button type="button" className="pop-out-btn" onClick={handleClearQuestion} disabled={!question && !askError}>
            Clear
          </button>
          <button type="button" className="pop-out-btn" onClick={handleAsk} disabled={!question.trim() || asking}>
            {asking ? "Asking…" : "Ask"}
          </button>
        </div>
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
        <h2 className="panel-title">Processing Filter</h2>
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
        <h2 className="panel-title">Export</h2>
        <ExportButtons api={api} matterId={matterId} selectedDocumentIds={selectedDocumentIds} />
        <p className="export-hint">
          {selectedDocumentIds.length === 0
            ? "Check documents in the table to enable export."
            : `Exports the ${selectedDocumentIds.length} currently checked document${selectedDocumentIds.length === 1 ? "" : "s"} — as a zip (Export documents) or a metadata CSV (Export properties).`}
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
              {members.map((member) => {
                // The creator's own row — server-enforced too (matterMembers.ts's
                // DELETE /:userId), this is just so the control never looks
                // clickable in the first place.
                const isCreatorRemovingSelf = member.userId === currentUserId && currentUserId === matterCreatedBy;
                return (
                  <tr key={member.userId}>
                    <td className="access-list-name">{member.name ?? member.email}</td>
                    {canManageAccess && (
                      <td className="access-list-remove">
                        <button
                          type="button"
                          className="access-list-remove-btn"
                          aria-label={isCreatorRemovingSelf ? "The matter's creator cannot remove themselves" : `Remove ${member.email}`}
                          title={isCreatorRemovingSelf ? "The matter's creator cannot remove themselves from its access list" : undefined}
                          disabled={busyUserId === member.userId || isCreatorRemovingSelf}
                          onClick={() => handleRemoveMember(member)}
                        >
                          ×
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
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
