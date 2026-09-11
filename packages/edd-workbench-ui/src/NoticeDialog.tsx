import { useEffect, useState } from "react";
import { Modal } from "antd";

export interface NoticeDialogProps {
  onClose: () => void;
}

/**
 * Displays NOTICE.md (open-source attributions + the XBundle Ltd copyright
 * notice). Fetched at runtime from the client's own public/ dir (served at
 * `/NOTICE.md`, the same static-asset path the logo/favicon already use)
 * rather than bundled at build time — this is the single copy also linked
 * from the repo's README, so there's nothing to keep in sync. Rendered as
 * plain preformatted text, not parsed markdown: no markdown renderer
 * exists in this codebase, and NOTICE.md's own formatting (headings, a
 * table) reads fine unrendered.
 *
 * On antd's Modal for the same reasons as ConfirmDialog — focus trap,
 * Escape handling, focus restoration — none of which the hand-rolled
 * overlay provided.
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

  return (
    <Modal open title="Third-party notices" onCancel={onClose} onOk={onClose} footer={null} width={720} aria-label="Third-party notices">
      {error && <p className="mt-1.5 text-xs text-seal">{error}</p>}
      {!error && !text && <p className="px-0.5 py-1 text-xs italic text-ink-soft">Loading…</p>}
      {/* max-h-[60vh] rather than a full-height panel: the notices are long,
          and the modal should scroll its own body, not the page. */}
      {text && <pre className="my-2 max-h-[60vh] overflow-y-auto text-xs whitespace-pre-wrap">{text}</pre>}
    </Modal>
  );
}
