import { useEffect } from "react";
import { createPortal } from "react-dom";

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Real, functional confirm dialog — reuses the .modal-overlay/.modal-panel/
 * .modal-panel-head chrome already in styles.css, left there specifically
 * for "the next dialog that needs it" after ExportButtons dropped an
 * earlier confirmation modal that wasn't backing a real feature (see that
 * file's own comment). Escape-to-close lives here, in the component, per
 * that same CSS comment's explicit note that it's not a pure-CSS concern.
 */
export function ConfirmDialog({ title, message, confirmLabel = "Confirm", onConfirm, onCancel }: ConfirmDialogProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="modal-panel-head">
          <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
        </div>
        <p style={{ margin: "8px 0 20px", color: "var(--ink-soft)" }}>{message}</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="pop-out-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="pop-out-btn"
            style={{ borderColor: "var(--seal)", color: "var(--seal)", background: "var(--seal-soft)" }}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
