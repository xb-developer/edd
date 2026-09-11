import { useEffect, useState } from "react";
import { ConfigProvider } from "antd";
import { antdTheme } from "./antdTheme";
import { createApiClient, ApiError } from "./api";
import type { DocumentDTO } from "./types";
import { DocumentViewer } from "./DocumentViewer";
import { openViewerChannel, postViewerMessage, subscribeToViewerChannel } from "./viewer-window/viewerChannel";

export interface DocumentViewerWindowProps {
  apiBaseUrl?: string;
  getAccessToken: () => Promise<string>;
  matterId: string;
  sessionId: string;
  initialDocumentId: string | null;
}

/**
 * The popped-out viewer window's entire UI — no document list, no coding
 * panel. Reuses `DocumentViewer` unchanged; none of the per-format
 * rendering needs to know it's running in a separate window. Selection
 * updates arrive over `BroadcastChannel` (see viewer-window/), not props —
 * this component owns its own subscription and re-fetches the document by
 * id rather than receiving the full DTO over the channel (avoids pushing
 * potentially-large docx/xlsx metadata blobs through structured-clone
 * across realms).
 */
export function DocumentViewerWindow(props: DocumentViewerWindowProps) {
  // A real separate window with its own document and its own React root, so
  // antd's own style injection lands correctly here without a StyleProvider
  // — unlike PiP mode, which shares the opener's realm (see MatterDetail).
  return (
    <ConfigProvider theme={antdTheme}>
      <DocumentViewerWindowInner {...props} />
    </ConfigProvider>
  );
}

function DocumentViewerWindowInner({ apiBaseUrl = "http://localhost:4430/api", getAccessToken, matterId, sessionId, initialDocumentId }: DocumentViewerWindowProps) {
  const [api] = useState(() => createApiClient(apiBaseUrl, getAccessToken));
  const [documentId, setDocumentId] = useState(initialDocumentId);
  const [document, setDocument] = useState<DocumentDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    const channel = openViewerChannel();
    postViewerMessage(channel, { type: "hello", sessionId });

    const unsubscribe = subscribeToViewerChannel(channel, sessionId, (message) => {
      if (message.type === "select") setDocumentId(message.documentId);
      else if (message.type === "close") window.close();
    });

    const onPageHide = () => postViewerMessage(channel, { type: "closing", sessionId });
    window.addEventListener("pagehide", onPageHide);

    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", onPageHide);
      channel.close();
    };
  }, [sessionId]);

  useEffect(() => {
    setError(null);
    setDocument(null);
    if (!documentId) return;

    api
      .getDocument(matterId, documentId)
      .then((doc) => {
        setDocument(doc);
        window.document.title = `${doc.originalFilename} — Collate Viewer`;
      })
      .catch((err) => {
        // A 401 here (expired/cleared token) is the one case worth telling
        // the user apart from any other fetch failure — the fix is
        // "reopen the viewer," not "retry," and this window's own
        // Auth0Provider has no redirect path that would land back here
        // usefully (see main.tsx's cacheLocation comment).
        if (err instanceof ApiError && err.status === 401) setSessionExpired(true);
        else setError((err as Error).message);
      });
  }, [api, matterId, documentId]);

  if (sessionExpired) {
    return <p className="rounded-[4px] border border-dashed border-line p-6 text-center text-xs text-ink-soft">Session expired — close this window and reopen the viewer from the main application.</p>;
  }
  if (error) return <p className="rounded-[4px] border border-dashed border-line p-6 text-center text-xs text-ink-soft">{error}</p>;
  if (!documentId) return <p className="p-4 text-center text-xs italic text-ink-soft">No document selected.</p>;
  if (!document) return <p className="px-0.5 py-1 text-xs italic text-ink-soft">Loading document…</p>;

  return <DocumentViewer api={api} matterId={matterId} document={document} />;
}
