import { useEffect, useState } from "react";
import { createApiClient } from "./api";
import type { AssemblyView } from "./types";
import { DocumentStagingList } from "./components/DocumentStagingList";
import { BundleOrganizer } from "./components/BundleOrganizer";
import { CaseHeadingForm } from "./components/CaseHeadingForm";
import { ExportPicker } from "./components/ExportPicker";

export interface AssembleWorkspaceProps {
  /** Defaults to the standalone app's own local server. A future host embedding this component elsewhere can point it at a different origin. */
  apiBaseUrl?: string;
  /**
   * Native multi-file picker. Undefined (e.g. running outside Electron) falls
   * back to a manual newline-separated path textarea, purely for testing this
   * component in a plain browser.
   */
  onPickFiles?: () => Promise<string[] | null>;
  /** Native single-file picker for choosing a built bundle PDF to open. Undefined outside Electron — the "Open bundle…" button is hidden in that case, same as onPickFiles. */
  onPickBundleFile?: () => Promise<string | null>;
  /** Native folder picker for where to save a bundle's split-out per-document PDFs — asked fresh each time a bundle is opened. */
  onPickFolder?: () => Promise<string | null>;
}

export function AssembleWorkspace({
  apiBaseUrl = "http://localhost:4410/api",
  onPickFiles,
  onPickBundleFile,
  onPickFolder,
}: AssembleWorkspaceProps) {
  const [api] = useState(() => createApiClient(apiBaseUrl));
  const [assembly, setAssembly] = useState<AssemblyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [manualPaths, setManualPaths] = useState("");
  const [showCaseDetails, setShowCaseDetails] = useState(false);

  function refresh() {
    api.getAssembly().then(setAssembly).catch((err) => setError(err.message));
  }

  useEffect(refresh, []);

  async function withErrorHandling(action: () => Promise<void>) {
    try {
      setError(null);
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleImportClick() {
    if (onPickFiles) {
      const filePaths = await onPickFiles();
      if (!filePaths || filePaths.length === 0) return;
      await withErrorHandling(async () => {
        await api.importDocuments(filePaths);
        refresh();
      });
    }
  }

  async function handleOpenBundleClick() {
    if (!onPickBundleFile || !onPickFolder) return;
    const filePath = await onPickBundleFile();
    if (!filePath) return;
    const destFolder = await onPickFolder();
    if (!destFolder) return;
    await withErrorHandling(async () => {
      await api.openBundle(filePath, destFolder);
      refresh();
    });
  }

  async function handleManualImport(e: React.FormEvent) {
    e.preventDefault();
    const filePaths = manualPaths
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    if (filePaths.length === 0) return;
    await withErrorHandling(async () => {
      await api.importDocuments(filePaths);
      setManualPaths("");
      refresh();
    });
  }

  async function handleExport(bundleIds: string[]) {
    await withErrorHandling(async () => {
      setExportStatus("Exporting…");
      const result = await api.exportBundle(undefined, bundleIds);
      setExportStatus(`Exported to ${result.outputPath}`);
    });
  }

  if (!assembly) {
    return <div className="assemble-workspace assemble-workspace--loading">Loading…</div>;
  }

  return (
    <div className="assemble-workspace">
      <header className="assemble-workspace__header">
        <h1>XBundle Assemble</h1>
        <div className="assemble-workspace__actions">
          <button onClick={() => setShowCaseDetails((v) => !v)}>Case details…</button>
          {onPickFiles ? (
            <button onClick={handleImportClick}>Import documents…</button>
          ) : null}
          {onPickBundleFile && onPickFolder ? (
            <button onClick={handleOpenBundleClick}>Open bundle…</button>
          ) : null}
          <ExportPicker bundles={assembly.bundles} onExport={handleExport} />
        </div>
      </header>

      {showCaseDetails && <CaseHeadingForm api={api} onClose={() => setShowCaseDetails(false)} />}

      {!onPickFiles && (
        <form className="manual-import" onSubmit={handleManualImport}>
          <textarea
            placeholder="Absolute PDF paths, one per line (no native file picker outside Electron)"
            value={manualPaths}
            onChange={(e) => setManualPaths(e.target.value)}
            rows={2}
          />
          <button type="submit">Import</button>
        </form>
      )}

      {error && <p className="error">{error}</p>}
      {exportStatus && <p className="status">{exportStatus}</p>}

      <div className="assemble-workspace__body">
        <DocumentStagingList
          documents={assembly.staging}
          bundles={assembly.bundles}
          onAssignMany={(docIds, tabId) =>
            withErrorHandling(async () => {
              await Promise.all(docIds.map((docId) => api.assignDocument(docId, tabId)));
              refresh();
            })
          }
          onRemove={(docId) =>
            withErrorHandling(async () => {
              await api.deleteDocument(docId);
              refresh();
            })
          }
          onRemoveMany={(docIds) =>
            withErrorHandling(async () => {
              await Promise.all(docIds.map((docId) => api.deleteDocument(docId)));
              refresh();
            })
          }
        />

        <BundleOrganizer
          bundles={assembly.bundles}
          onAddBundle={(label) =>
            withErrorHandling(async () => {
              await api.createBundle(label);
              refresh();
            })
          }
          onDeleteBundle={(id) =>
            withErrorHandling(async () => {
              await api.deleteBundle(id);
              refresh();
            })
          }
          onUpdateBundleTitle={(id, title) =>
            withErrorHandling(async () => {
              await api.updateBundleTitle(id, title);
              refresh();
            })
          }
          onUpdateBundleLabel={(id, label) =>
            withErrorHandling(async () => {
              await api.updateBundleLabel(id, label);
              refresh();
            })
          }
          onAddTab={(bundleId, title) =>
            withErrorHandling(async () => {
              await api.createTab(bundleId, title);
              refresh();
            })
          }
          onAddSubTab={(parentTabId, title) =>
            withErrorHandling(async () => {
              await api.createSubTab(parentTabId, title);
              refresh();
            })
          }
          onDeleteTab={(id) =>
            withErrorHandling(async () => {
              await api.deleteTab(id);
              refresh();
            })
          }
          onUnassignDocument={(docId) =>
            withErrorHandling(async () => {
              await api.assignDocument(docId, null);
              refresh();
            })
          }
          onMoveDocument={(docId, direction, tabDocumentIds) =>
            withErrorHandling(async () => {
              const i = tabDocumentIds.indexOf(docId);
              const swapWith = direction === "up" ? i - 1 : i + 1;
              if (swapWith < 0 || swapWith >= tabDocumentIds.length) return;
              const reordered = [...tabDocumentIds];
              [reordered[i], reordered[swapWith]] = [reordered[swapWith], reordered[i]];
              await api.reorderDocuments(reordered);
              refresh();
            })
          }
          onUpdateDocumentDate={(docId, date) =>
            withErrorHandling(async () => {
              await api.updateDocumentDate(docId, date);
              refresh();
            })
          }
          onUpdateDocumentTitle={(docId, title) =>
            withErrorHandling(async () => {
              await api.updateDocumentTitle(docId, title);
              refresh();
            })
          }
        />
      </div>
    </div>
  );
}
