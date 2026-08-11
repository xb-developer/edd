import type { AssemblyView, CaseHeadingDTO, DocumentDTO } from "./types";

// Base URL is a parameter, not a hardcoded constant — so a future host (e.g.
// Assemble embedded inside Create, talking to a differently-configured
// backend) can point this at a different origin without editing this file.
export function createApiClient(baseUrl: string) {
  async function json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Request failed: ${res.status}`);
    }
    return res.json();
  }

  return {
    getAssembly: () => fetch(`${baseUrl}/assembly`).then((r) => json<AssemblyView>(r)),

    importDocuments: (filePaths: string[]) =>
      fetch(`${baseUrl}/documents/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePaths }),
      }).then((r) => json<DocumentDTO[]>(r)),

    openBundle: (filePath: string, destFolder: string) =>
      fetch(`${baseUrl}/assembly/open-bundle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, destFolder }),
      }).then((r) => json<AssemblyView>(r)),

    deleteDocument: (id: string) => fetch(`${baseUrl}/documents/${id}`, { method: "DELETE" }),

    updateDocumentDate: (id: string, date: string) =>
      fetch(`${baseUrl}/documents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      }),

    updateDocumentTitle: (id: string, title: string) =>
      fetch(`${baseUrl}/documents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }),

    createBundle: (label: string) =>
      fetch(`${baseUrl}/assembly/bundles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      }).then((r) => json<AssemblyView>(r)),

    deleteBundle: (id: string) =>
      fetch(`${baseUrl}/assembly/bundles/${id}`, { method: "DELETE" }).then((r) => json<AssemblyView>(r)),

    updateBundleTitle: (id: string, title: string) =>
      fetch(`${baseUrl}/assembly/bundles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }).then((r) => json<AssemblyView>(r)),

    updateBundleLabel: (id: string, label: string) =>
      fetch(`${baseUrl}/assembly/bundles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      }).then((r) => json<AssemblyView>(r)),

    createTab: (bundleId: string, title: string) =>
      fetch(`${baseUrl}/assembly/bundles/${bundleId}/tabs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }).then((r) => json<AssemblyView>(r)),

    createSubTab: (parentTabId: string, title: string) =>
      fetch(`${baseUrl}/assembly/tabs/${parentTabId}/subtabs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }).then((r) => json<AssemblyView>(r)),

    deleteTab: (id: string) =>
      fetch(`${baseUrl}/assembly/tabs/${id}`, { method: "DELETE" }).then((r) => json<AssemblyView>(r)),

    assignDocument: (documentId: string, tabId: string | null) =>
      fetch(`${baseUrl}/assembly/documents/${documentId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId }),
      }).then((r) => json<AssemblyView>(r)),

    reorderDocuments: (orderedIds: string[]) =>
      fetch(`${baseUrl}/assembly/documents/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds }),
      }).then((r) => json<AssemblyView>(r)),

    exportBundle: (outputPath?: string, bundleIds?: string[]) =>
      fetch(`${baseUrl}/assembly/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outputPath, bundleIds }),
      }).then((r) => json<{ outputPath: string }>(r)),

    getCaseHeading: () => fetch(`${baseUrl}/case-heading`).then((r) => json<CaseHeadingDTO>(r)),

    saveCaseHeading: (heading: CaseHeadingDTO) =>
      fetch(`${baseUrl}/case-heading`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(heading),
      }).then((r) => json<CaseHeadingDTO>(r)),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
