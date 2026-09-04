import type { DocumentDTO } from "./types";
import { formatDate, formatSize } from "./format";
import { displayName } from "./displayName";

export interface DocumentPropertiesPanelProps {
  document: DocumentDTO;
}

/**
 * Read-only GUID + metadata summary, rendered above whichever preview is
 * currently showing for the selected document — ports the POC's
 * PreviewPane.tsx doc-head/meta-grid block, which never fully made it into
 * this app (only its .guid-badge-sm CSS class survived the earlier port,
 * unused). Deliberately no editing affordance here — nothing in the
 * request implies one, and CodingPanel already owns the one place tag
 * state is actually mutated.
 */
export function DocumentPropertiesPanel({ document }: DocumentPropertiesPanelProps) {
  const metadata = (document.metadata ?? {}) as Record<string, unknown>;
  const to = typeof metadata.to === "string" ? metadata.to : null;
  const cc = typeof metadata.cc === "string" ? metadata.cc : null;
  // familyGuid is never null (a childless document is its own family) — see
  // types.ts's own comment on the field. Only show the row when this
  // document genuinely has a parent.
  const hasFamily = document.familyGuid !== document.guid;

  return (
    <div className="doc-head">
      <span className="guid-badge">{document.guid}</span>
      <div className="dname">{displayName(document)}</div>
      <dl className="meta-grid">
        <dt>Type</dt>
        <dd>{document.extension || document.contentTypeDetected}</dd>
        <dt>Size</dt>
        <dd>{formatSize(document.sizeBytes)}</dd>
        <dt>Date</dt>
        <dd>{formatDate(document.docDate)}</dd>
        <dt>Modified</dt>
        <dd>{formatDate(document.fileModifiedAt)}</dd>
        {document.author && (
          <>
            <dt>Author</dt>
            <dd>{document.author}</dd>
          </>
        )}
        {to && (
          <>
            <dt>To</dt>
            <dd>{to}</dd>
          </>
        )}
        {cc && (
          <>
            <dt>Cc</dt>
            <dd>{cc}</dd>
          </>
        )}
        {document.parentGuid && (
          <>
            <dt>Attached to</dt>
            <dd>{document.parentGuid}</dd>
          </>
        )}
        {hasFamily && (
          <>
            <dt>Family</dt>
            <dd>{document.familyGuid}</dd>
          </>
        )}
        {document.ingestStatus === "failed" && document.ingestError && (
          <>
            <dt>Ingest error</dt>
            <dd>{document.ingestError}</dd>
          </>
        )}
        {document.contentWarning && (
          <>
            <dt style={{ color: "#A6362C" }}>⚠ Warning</dt>
            <dd style={{ color: "#A6362C" }}>{document.contentWarning}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
