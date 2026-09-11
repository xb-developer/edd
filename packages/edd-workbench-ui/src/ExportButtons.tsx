import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api";

export interface ExportButtonsProps {
  api: ApiClient;
  matterId: string;
  /** The bulk-select checkbox column's checked ids — both buttons are scoped to exactly this set, never "everything in the matter" (see FilterPanel's own comment on this same prop). */
  /** The checked set itself — materialized to an array only in the click handler below, not on every render. */
  selectedDocumentIds: ReadonlySet<string>;
}

const POLL_INTERVAL_MS = 1500;

type ExportKind = "documents" | "properties";

const KIND_LABEL: Record<ExportKind, string> = {
  documents: "Export documents",
  properties: "Export properties",
};

interface ExportButtonState {
  inFlight: boolean;
  error: string | null;
}

const IDLE_STATE: ExportButtonState = { inFlight: false, error: null };

/**
 * Two selection-scoped export buttons, backed by the real create-job ->
 * enqueue -> worker-builds-artifact -> poll -> presigned-download flow (see
 * api.ts's requestExport/getExportStatus/getExportDownloadUrl). Replaces
 * ExportButton.tsx's single "export matter" button and its fake
 * confirmation modal — that modal existed only to make a non-functional
 * feature look real; a real, selection-scoped, clearly-labeled action
 * doesn't need one.
 */
export function ExportButtons({ api, matterId, selectedDocumentIds }: ExportButtonsProps) {
  const [documentsState, setDocumentsState] = useState<ExportButtonState>(IDLE_STATE);
  const [propertiesState, setPropertiesState] = useState<ExportButtonState>(IDLE_STATE);

  // A poll loop that resolves after this component's gone (e.g. the user
  // navigated away from the matter mid-export) must not call setState on a
  // dead component, and shouldn't keep hitting the API forever either.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function runExport(kind: ExportKind) {
    const setState = kind === "documents" ? setDocumentsState : setPropertiesState;
    setState({ inFlight: true, error: null });

    try {
      const { exportId } = await api.requestExport(matterId, kind, Array.from(selectedDocumentIds));

      // Plain poll loop, no backoff — export jobs are short-lived enough
      // (build plan §G) that a fixed 1.5s interval is all this needs.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (!mountedRef.current) return;

        const job = await api.getExportStatus(matterId, exportId);
        if (job.status === "ready") {
          const { downloadUrl } = await api.getExportDownloadUrl(matterId, exportId);
          // Not window.open(): by the time a 1.5s+ poll resolves, the click
          // that started this is no longer an active user gesture, and
          // browsers gate window.open on one — it would silently get
          // popup-blocked in exactly the case that matters (a slow export).
          // A synthetic anchor click is treated as a download, not a
          // popup, and survives the lost-gesture case.
          const link = document.createElement("a");
          link.href = downloadUrl;
          link.rel = "noopener";
          link.click();
          break;
        }
        if (job.status === "failed") {
          throw new Error(job.error ?? "Export failed");
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      if (mountedRef.current) setState({ inFlight: false, error: null });
    } catch (err) {
      if (mountedRef.current) setState({ inFlight: false, error: (err as Error).message });
    }
  }

  return (
    <>
      {(["documents", "properties"] as const).map((kind) => {
        const state = kind === "documents" ? documentsState : propertiesState;
        return (
          <button
            key={kind}
            type="button"
            className="export-btn"
            disabled={selectedDocumentIds.size === 0 || state.inFlight}
            onClick={() => runExport(kind)}
          >
            <span className="ico">▤</span> {state.inFlight ? "Exporting…" : KIND_LABEL[kind]}
          </button>
        );
      })}
      {documentsState.error && <p className="preview-unsupported">Export documents failed: {documentsState.error}</p>}
      {propertiesState.error && <p className="preview-unsupported">Export properties failed: {propertiesState.error}</p>}
    </>
  );
}
