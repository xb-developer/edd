import { useEffect, useState } from "react";
import { useBoundApi } from "../useCloudApi";
import type { DocumentDetail } from "../types";

interface Props {
  documentId: string;
}

/**
 * Deliberately plain: extracted text + a download link for the original.
 * cloud-backend's extraction pipeline (Section 3.2/Phase 2) doesn't render
 * rich previews server-side the way the desktop app's officeparser/mammoth
 * pipeline does — showing anything fancier here would be pretending to a
 * capability that doesn't exist yet.
 */
export function DocumentPreview({ documentId }: Props) {
  const api = useBoundApi();
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDoc(null);
    setDownloadUrl(null);
    api.getDocument(documentId).then(setDoc).catch((e) => setError(String(e)));
    api
      .getDownloadUrl(documentId)
      .then((r) => setDownloadUrl(r.url))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  if (error) return <div className="preview-pane error-text">{error}</div>;
  if (!doc) return <div className="preview-pane">Loading…</div>;

  return (
    <div className="preview-pane">
      <div className="preview-header">
        <strong>{doc.filename}</strong>
        {downloadUrl && (
          <a href={downloadUrl} target="_blank" rel="noreferrer">
            Download original
          </a>
        )}
      </div>
      {doc.status === "extraction_failed" ? (
        <p className="error-text">Extraction failed: {doc.extraction_error}</p>
      ) : doc.status === "pending_extraction" ? (
        <p className="muted">Still processing…</p>
      ) : (
        <pre className="preview-text">{doc.extracted_text || "(no text extracted)"}</pre>
      )}
    </div>
  );
}
