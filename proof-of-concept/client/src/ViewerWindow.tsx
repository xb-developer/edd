import { useEffect, useState } from "react";
import { api } from "./api";
import type { DocumentDTO } from "./types";
import { PreviewPane } from "./components/PreviewPane";

// Standalone root rendered in the pop-out viewer window (loaded with
// ?viewer=1 — see main.tsx). Has no document list of its own; it's driven
// entirely by "viewer:selected" IPC messages from the main window, relayed
// through the Electron main process (see electron/main.ts).
export default function ViewerWindow() {
  const [doc, setDoc] = useState<DocumentDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "EDD Workbench — Viewer";
  }, []);

  useEffect(() => {
    if (!window.edd?.onViewerSelection) return;
    return window.edd.onViewerSelection((guid) => {
      setError(null);
      if (!guid) {
        setDoc(null);
        return;
      }
      api
        .getDocument(guid)
        .then(setDoc)
        .catch((err) => {
          setDoc(null);
          setError((err as Error).message);
        });
    });
  }, []);

  return (
    <div className="viewer-window">
      {error ? (
        <div className="no-selection">Could not load this document: {error}</div>
      ) : (
        <PreviewPane doc={doc} />
      )}
    </div>
  );
}
