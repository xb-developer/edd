import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { DocumentDTO, PreviewPayload } from "../types";
import { api } from "../api";
import { formatDate, formatSize } from "../lib/format";
import { displayName } from "../lib/displayName";

interface Props {
  doc: DocumentDTO | null;
  /** Present only in the main window — omitted inside the pop-out viewer itself. */
  onPopOut?: () => void;
  /** Overrides the default 55%-of-column flex sizing — used by the main
   *  window to make this panel's height user-resizable against Coding. */
  style?: CSSProperties;
}

export function PreviewPane({ doc, onPopOut, style }: Props) {
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    setPreview(null);
    setActiveSheet(0);
    if (!doc) return;
    setLoading(true);
    api
      .getPreview(doc.guid)
      .then(setPreview)
      .catch((err) => setPreview({ kind: "error", message: (err as Error).message }))
      .finally(() => setLoading(false));
  }, [doc?.guid]);

  return (
    <div className="split-pane" style={{ flex: "1 1 55%", ...style }}>
      <div className="pane-title-row">
        <h3 className="pane-title">Preview</h3>
        {onPopOut && (
          <button className="pop-out-btn" onClick={onPopOut} title="Open the viewer in a separate window">
            ⧉ Pop out
          </button>
        )}
      </div>
      <div className="panel-body">
        {!doc ? (
          <div className="no-selection">Select a document from the register to preview it.</div>
        ) : (
          <>
            <div className="doc-head">
              <span className="guid-badge">{doc.guid}</span>
              {doc.extra?.ocr === true && (
                <span className="guid-badge" style={{ background: "var(--amber)", marginLeft: 6 }} title="Text was extracted via OCR, not a native text layer — verify accuracy">
                  OCR
                </span>
              )}
              <div className="dname">{displayName(doc)}</div>
              <dl className="meta-grid">
                <dt>Size</dt>
                <dd>{formatSize(doc.sizeBytes)}</dd>
                <dt>Modified</dt>
                <dd>{formatDate(doc.dateModified)}</dd>
                <dt>Created</dt>
                <dd>{formatDate(doc.dateCreated)}</dd>
                {doc.title && (
                  <>
                    <dt>Title</dt>
                    <dd>{doc.title}</dd>
                  </>
                )}
                {doc.author && (
                  <>
                    <dt>Author</dt>
                    <dd>{doc.author}</dd>
                  </>
                )}
                {doc.parentGuid && (
                  <>
                    <dt>Attached to</dt>
                    <dd>{doc.parentGuid}</dd>
                  </>
                )}
                {doc.familyId && doc.familyId !== doc.guid && (
                  <>
                    <dt>Family</dt>
                    <dd>{doc.familyId}</dd>
                  </>
                )}
              </dl>
            </div>

            {loading && <div className="empty-note">Loading preview…</div>}
            {!loading && preview && renderPreview(doc, preview, activeSheet, setActiveSheet)}
          </>
        )}
      </div>
    </div>
  );
}

function renderPreview(
  doc: DocumentDTO,
  preview: PreviewPayload,
  activeSheet: number,
  setActiveSheet: (i: number) => void,
) {
  switch (preview.kind) {
    case "html":
      return <div className="preview-html" dangerouslySetInnerHTML={{ __html: preview.html }} />;

    case "text":
      return <pre className="preview-text">{preview.text}</pre>;

    case "pdf":
      return <iframe className="preview-frame" title="pdf" src={api.fileUrl(doc.guid)} />;

    case "htmlFile":
      // Empty sandbox — no scripts, forms, popups, or top-navigation. The
      // server also sends a strict CSP on this response (see content.ts)
      // blocking outbound network fetches, so an untrusted document can't
      // use e.g. a tracking-pixel <img> to signal that it was opened.
      return <iframe className="preview-frame" title="html" src={api.fileUrl(doc.guid)} sandbox="" />;

    case "tiff":
      return (
        <>
          {preview.pages.map((src, i) => (
            <div key={i}>
              {preview.pages.length > 1 && <div className="slide-num">Page {i + 1}</div>}
              <img className="preview-img" alt={`${doc.originalName} page ${i + 1}`} src={src} />
            </div>
          ))}
        </>
      );

    case "image": {
      const ocrText = typeof doc.extra?.ocrText === "string" ? doc.extra.ocrText : null;
      return (
        <>
          <img className="preview-img" alt={doc.originalName} src={api.fileUrl(doc.guid)} />
          {ocrText && (
            <>
              <h3 className="pane-title" style={{ margin: "12px 0 6px", padding: 0, border: "none" }}>
                Text recognized via OCR
              </h3>
              <pre className="preview-text">{ocrText}</pre>
            </>
          )}
        </>
      );
    }

    case "sheets": {
      const sheet = preview.sheets[activeSheet] ?? preview.sheets[0];
      return (
        <>
          {preview.sheets.length > 1 && (
            <div className="preview-sheet-tabs">
              {preview.sheets.map((s, i) => (
                <button key={s.name} className={i === activeSheet ? "active" : ""} onClick={() => setActiveSheet(i)}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
          <div className="preview-table-wrap">
            <table className="preview-table">
              <tbody>
                {sheet.rows.slice(0, 500).map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      );
    }

    case "slides":
      return (
        <>
          {preview.slides.map((s) => (
            <div key={s.index} className="slide-block">
              <div className="slide-num">Slide {s.index}</div>
              <div>{s.text || <span className="muted">(no text on this slide)</span>}</div>
            </div>
          ))}
        </>
      );

    case "email":
      return (
        <>
          <div className="email-head">
            <div>
              <span className="email-label">From</span> {preview.from ?? "—"}
            </div>
            <div>
              <span className="email-label">To</span> {preview.to ?? "—"}
            </div>
            {preview.cc && (
              <div>
                <span className="email-label">Cc</span> {preview.cc}
              </div>
            )}
            <div>
              <span className="email-label">Date</span> {formatDate(preview.date)}
            </div>
            <div>
              <span className="email-label">Subject</span> {preview.subject ?? "—"}
            </div>
          </div>
          {preview.attachments.length > 0 && (
            <div className="email-attachments">
              {preview.attachments.map((a, i) => (
                <span key={i} className="chip" style={{ background: "var(--slate-soft)", color: "var(--ink-soft)" }}>
                  {a.filename}
                </span>
              ))}
            </div>
          )}
          {preview.bodyHtml ? (
            <div className="preview-html" dangerouslySetInnerHTML={{ __html: preview.bodyHtml }} />
          ) : (
            <pre className="preview-text">{preview.bodyText || "(no readable body)"}</pre>
          )}
        </>
      );

    case "error":
      return <div className="preview-unsupported">Preview failed: {preview.message}</div>;

    default:
      return <div className="preview-unsupported">No preview available for this file type.</div>;
  }
}
