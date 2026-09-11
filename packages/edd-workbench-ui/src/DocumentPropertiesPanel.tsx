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
    <div className="mb-3">
      <span className="mb-1.5 inline-block rounded-[3px] bg-navy px-2 py-0.5 font-mono text-[11px] font-semibold text-white">{document.guid}</span>
      <div className="text-[13.5px] font-semibold break-words">{displayName(document)}</div>
      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-[5px] text-[11.5px] [&_dt]:text-ink-soft [&_dd]:m-0 [&_dd]:break-words">
        <dt>Type</dt>
        <dd>{document.extension || document.contentTypeDetected}</dd>
        <dt>Size</dt>
        <dd>{formatSize(document.sizeBytes)}</dd>
        <dt>Date</dt>
        <dd>{formatDate(document.docDate)}</dd>
        <dt>Modified</dt>
        {/* The document's OWN internal last-modified property (PDF's
            /ModDate, docx/pptx/xlsx's dcterms:modified, etc.) — preferred
            over fileModifiedAt (the uploaded file's browser-reported
            File.lastModified), which is never set at all for an
            attachment (there's no browser file input involved when a PDF
            arrives as an email attachment) and is a less meaningful
            "modified" answer even for a top-level upload. Falls back to
            fileModifiedAt only when the format has no internal property
            to read (plain text/other) or extraction found none. */}
        <dd>{formatDate(document.contentModifiedAt ?? document.fileModifiedAt)}</dd>
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
