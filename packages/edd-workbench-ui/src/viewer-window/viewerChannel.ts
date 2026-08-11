export const VIEWER_CHANNEL_NAME = "edd-workbench:viewer";

export type ViewerMessage =
  | { type: "select"; sessionId: string; matterId: string; documentId: string | null }
  | { type: "close"; sessionId: string }
  | { type: "hello"; sessionId: string }
  | { type: "closing"; sessionId: string };

/**
 * Every message carries a `sessionId` (generated per `MatterDetail` mount,
 * persisted in sessionStorage per-tab-per-matter) so two browser tabs of
 * this app never cross-wire each other's viewer windows — a real gap the
 * POC's single-Electron-window design never had to consider, since Electron
 * only ever had one main window. `subscribeToViewerChannel` filters out any
 * message whose `sessionId` doesn't match the caller's own, so callers never
 * need to repeat that check themselves.
 */
export function openViewerChannel(): BroadcastChannel {
  return new BroadcastChannel(VIEWER_CHANNEL_NAME);
}

export function postViewerMessage(channel: BroadcastChannel, message: ViewerMessage): void {
  channel.postMessage(message);
}

export function subscribeToViewerChannel(channel: BroadcastChannel, sessionId: string, onMessage: (message: ViewerMessage) => void): () => void {
  const listener = (event: MessageEvent<ViewerMessage>) => {
    if (event.data?.sessionId === sessionId) onMessage(event.data);
  };
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}
