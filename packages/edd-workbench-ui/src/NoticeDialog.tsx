import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface NoticeDialogProps {
  onClose: () => void;
}

/**
 * Displays NOTICE.md (open-source attributions + the XBundle Ltd copyright
 * notice) in the same .modal-overlay/.modal-panel chrome ConfirmDialog
 * uses. Fetched at runtime from the client's own public/ dir (served at
 * `/NOTICE.md`, same static-asset path the logo/favicon already use)
 * rather than bundled at build time — this is the single copy also linked
 * from the repo's own README, so there's nothing to keep in sync. Rendered
 * as plain preformatted text, not parsed markdown — no markdown-rendering
 * library exists in this codebase yet, and NOTICE.md's own formatting
 * (headings, a table) reads fine unrendered.
 */
export function NoticeDialog({ onClose }: NoticeDialogProps) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/NOTICE.md")
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load notices (${res.status})`);
        return res.text();
      })
      .then(setText)
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Third-party notices"
        style={{ width: 720 }}
      >
        <div className="modal-panel-head">
          <h3 style={{ margin: 0, fontSize: 15 }}>Third-party notices</h3>
        </div>
        {error && <p className="bulk-note">{error}</p>}
        {!error && !text && <p className="empty-note">Loading…</p>}
        {text && (
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, margin: "8px 0 20px", maxHeight: "60vh", overflowY: "auto" }}>{text}</pre>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="pop-out-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
