import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import type { ApiClient } from "./api";
import type { DocumentDTO } from "./types";
import { viewerKindFor } from "./viewers/viewerKind";
import { PptxSlideViewer } from "./viewers/PptxSlideViewer";
import { formatDate } from "./format";

export interface DocumentViewerProps {
  api: ApiClient;
  matterId: string;
  document: DocumentDTO;
}

// eml/msg render straight from the metadata already extracted and stored
// in Milestone 1 — no view-url fetch, no re-parsing the original bytes
// client-side (a deliberate grilling-session decision: avoids duplicating
// eml.ts/msg.ts's logic in the browser for no benefit). Every other type
// needs a fresh presigned GET URL, since there's no equivalent
// full-content extraction for those.
export function DocumentViewer({ api, matterId, document }: DocumentViewerProps) {
  const kind = viewerKindFor(document.contentTypeDetected);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // pptx also needs a view-url: @aiden0z/pptx-renderer (the chosen rendering
  // library) only runs in a live browser DOM, so unlike docx/xlsx it can't
  // be pre-extracted into metadata at ingest time — the client fetches the
  // raw bytes itself and hands them to the renderer directly.
  const needsViewUrl = kind === "native-pdf" || kind === "native-image" || kind === "native-text" || kind === "pptx";

  useEffect(() => {
    setViewUrl(null);
    setError(null);
    if (needsViewUrl) {
      api
        .getDocumentViewUrl(matterId, document.documentId)
        .then((r) => setViewUrl(r.viewUrl))
        .catch((err) => setError(err.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.documentId, kind]);

  if (kind === "email") {
    const metadata = (document.metadata ?? {}) as Record<string, unknown>;
    const attachments = Array.isArray(metadata.attachmentFilenames) ? (metadata.attachmentFilenames as string[]) : [];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", overflowY: "auto" }}>
        <dl className="email-head">
          <div>
            <span className="email-label">From</span> {document.author ?? "(unknown)"}
          </div>
          <div>
            <span className="email-label">To</span> {typeof metadata.to === "string" ? metadata.to : "(unknown)"}
          </div>
          {metadata.cc ? (
            <div>
              <span className="email-label">Cc</span> {String(metadata.cc)}
            </div>
          ) : null}
          <div>
            <span className="email-label">Date</span> {document.docDate ? formatDate(document.docDate) : "(unknown)"}
          </div>
          <div>
            <span className="email-label">Subject</span> {document.subject ?? "(no subject)"}
          </div>
        </dl>
        {typeof metadata.bodyHtml === "string" ? (
          // Email bodies are adversarial by construction here — this is
          // opposing/third-party correspondence in a multi-tenant app, not
          // trusted first-party content — so this can never render raw.
          // DOMPurify strips scripts/handlers/etc before it reaches the DOM.
          <div className="preview-html" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(metadata.bodyHtml) }} />
        ) : typeof metadata.bodyText === "string" && metadata.bodyText.length > 0 ? (
          <pre className="preview-text">{metadata.bodyText}</pre>
        ) : (
          // Some older Outlook messages store their body only as compressed
          // RTF, which msg.ts doesn't decode — this is that known,
          // deliberate limitation surfacing, not a bug to chase here.
          <p className="empty-note">No readable body.</p>
        )}
        {attachments.length > 0 && (
          <div className="email-attachments">
            {attachments.map((name) => (
              <span key={name} className="chip" style={{ background: "var(--slate-soft)", color: "var(--ink-soft)" }}>
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (error) return <div className="preview-unsupported">{error}</div>;
  if (needsViewUrl && !viewUrl) return <p className="empty-note">Loading preview…</p>;

  switch (kind) {
    case "native-pdf":
      return <iframe className="preview-frame" style={{ width: "100%", height: "100%", border: 0 }} src={viewUrl!} title={document.originalFilename} />;
    case "native-image":
      return <img className="preview-img" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} src={viewUrl!} alt={document.originalFilename} />;
    case "native-text":
      return <TextViewer url={viewUrl!} />;
    case "docx":
      return <DocxViewer html={(document.metadata as { html?: string | null } | null)?.html ?? null} />;
    case "extracted-text":
      return <ExtractedTextViewer text={(document.metadata as { text?: string | null } | null)?.text ?? null} />;
    case "xlsx":
      return <XlsxViewer sheets={(document.metadata as { sheets?: XlsxSheetView[] } | null)?.sheets ?? []} />;
    case "pptx":
      return <PptxSlideViewer url={viewUrl!} />;
    default:
      // A corrupt/unrecognized file (viewerKindFor's "unsupported") also
      // falls here — never a blank viewer with no explanation.
      return <div className="preview-unsupported">Preview not yet available for this file type ({document.contentTypeDetected}).</div>;
  }
}

function DocxViewer({ html }: { html: string | null }) {
  if (!html) return <div className="preview-unsupported">No preview available for this document.</div>;
  // Same threat model as the email body above: docx content is untrusted
  // third-party material, sanitized at render time rather than at
  // extraction time so storage always holds the original conversion.
  return <div className="preview-html" style={{ height: "100%" }} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;
}

function ExtractedTextViewer({ text }: { text: string | null }) {
  if (!text) return <div className="preview-unsupported">No preview available for this document.</div>;
  return <pre className="preview-text" style={{ height: "100%" }}>{text}</pre>;
}

interface XlsxSheetView {
  name: string;
  rows: (string | number | boolean | null)[][];
}

function XlsxViewer({ sheets }: { sheets: XlsxSheetView[] }) {
  const [activeSheet, setActiveSheet] = useState(0);
  if (sheets.length === 0) return <div className="preview-unsupported">No preview available for this spreadsheet.</div>;
  const sheet = sheets[Math.min(activeSheet, sheets.length - 1)];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
      {sheets.length > 1 && (
        <div className="preview-sheet-tabs">
          {sheets.map((s, i) => (
            <button key={s.name} type="button" className={i === activeSheet ? "active" : ""} onClick={() => setActiveSheet(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="preview-table-wrap" style={{ flex: 1 }}>
        <table className="preview-table">
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TextViewer({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then(setText);
  }, [url]);
  if (text === null) return <p className="empty-note">Loading preview…</p>;
  return <pre className="preview-text" style={{ height: "100%" }}>{text}</pre>;
}
