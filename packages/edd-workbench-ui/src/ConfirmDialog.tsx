import { Modal } from "antd";

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm dialog, on antd's Modal.
 *
 * The hand-rolled version this replaces portalled its own overlay and
 * wired up its own Escape listener. Modal brings those plus the parts that
 * were missing: a real focus trap, focus restored to the trigger on close,
 * `aria-modal` semantics managed for us, and scroll locking. This is the
 * kind of widget where "hand-built" was costing accessibility rather than
 * saving complexity.
 *
 * Rendered only while open (the caller mounts/unmounts it), so `open` is
 * always true — `destroyOnClose` is unnecessary for the same reason.
 */
export function ConfirmDialog({ title, message, confirmLabel = "Confirm", onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Modal
      open
      title={title}
      onOk={onConfirm}
      onCancel={onCancel}
      okText={confirmLabel}
      cancelText="Cancel"
      // Destructive by default: every current caller is a delete. antd
      // styles this from colorError, which antdTheme.ts maps to --seal —
      // the same colour the hand-built version set inline.
      okButtonProps={{ danger: true }}
      width={420}
    >
      <p className="text-ink-soft my-2">{message}</p>
    </Modal>
  );
}
