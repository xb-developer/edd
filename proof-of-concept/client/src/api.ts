import type { DocumentDTO, FilterMode, MatterInfo, PreviewPayload, Tag } from "./types";

const BASE = "http://localhost:4420/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // Route handlers send a real diagnostic message in the body
    // ({ error } or, for /preview, { kind: "error", message }) — surface
    // that instead of a bare status code so failures are actually debuggable.
    const body = await res.json().catch(() => null);
    const detail = body?.error ?? body?.message;
    throw new Error(detail ? `${res.status}: ${detail}` : `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listMatters(): Promise<{ matters: MatterInfo[]; active: MatterInfo | null }> {
    return fetch(`${BASE}/matters`).then((res) => json<{ matters: MatterInfo[]; active: MatterInfo | null }>(res));
  },

  createMatter(name: string): Promise<MatterInfo> {
    return fetch(`${BASE}/matters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((res) => json<MatterInfo>(res));
  },

  openMatter(id: string): Promise<MatterInfo> {
    return fetch(`${BASE}/matters/${id}/open`, { method: "POST" }).then((res) => json<MatterInfo>(res));
  },

  deleteMatter(id: string): Promise<{ matters: MatterInfo[]; active: MatterInfo | null }> {
    return fetch(`${BASE}/matters/${id}`, { method: "DELETE" }).then((res) =>
      json<{ matters: MatterInfo[]; active: MatterInfo | null }>(res),
    );
  },

  listDocuments(params: { q: string; tagIds: number[]; mode: FilterMode }): Promise<DocumentDTO[]> {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.tagIds.length) search.set("tags", params.tagIds.join(","));
    search.set("mode", params.mode);
    return fetch(`${BASE}/documents?${search.toString()}`).then((res) => json<DocumentDTO[]>(res));
  },

  // Fetches fresh (not from the main window's already-loaded list) — used by
  // the pop-out viewer window, which has no document list of its own and
  // should always reflect current tags/metadata rather than a stale snapshot
  // passed at selection time.
  getDocument(guid: string): Promise<DocumentDTO> {
    return fetch(`${BASE}/documents/${guid}`).then((res) => json<DocumentDTO>(res));
  },

  importPaths(paths: string[]): Promise<{ imported: DocumentDTO[]; errors: Array<{ path: string; error: string }> }> {
    return fetch(`${BASE}/documents/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    }).then((res) => json<{ imported: DocumentDTO[]; errors: Array<{ path: string; error: string }> }>(res));
  },

  deleteDocument(guid: string): Promise<{ ok: true }> {
    return fetch(`${BASE}/documents/${guid}`, { method: "DELETE" }).then((res) => json<{ ok: true }>(res));
  },

  listTags(): Promise<Tag[]> {
    return fetch(`${BASE}/tags`).then((res) => json<Tag[]>(res));
  },

  createTag(name: string, color: string): Promise<Tag> {
    return fetch(`${BASE}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color }),
    }).then((res) => json<Tag>(res));
  },

  applyTag(guids: string[], tagId: number): Promise<{ ok: true }> {
    return fetch(`${BASE}/tags/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guids, tagId }),
    }).then((res) => json<{ ok: true }>(res));
  },

  removeTag(guids: string[], tagId: number): Promise<{ ok: true }> {
    return fetch(`${BASE}/tags/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guids, tagId }),
    }).then((res) => json<{ ok: true }>(res));
  },

  getPreview(guid: string): Promise<PreviewPayload> {
    return fetch(`${BASE}/documents/${guid}/preview`).then((res) => json<PreviewPayload>(res));
  },

  fileUrl(guid: string): string {
    return `${BASE}/documents/${guid}/file`;
  },

  async ask(question: string): Promise<{ answer: string; sources: Array<{ guid: string; originalName: string; snippet: string }> }> {
    const res = await fetch(`${BASE}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    }
    return res.json();
  },

  async exportZip(guids: string[]): Promise<void> {
    const res = await fetch(`${BASE}/export/zip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guids }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    await downloadBlob(res, "edd-export.zip");
  },

  async exportCsv(guids: string[]): Promise<void> {
    const res = await fetch(`${BASE}/export/csv`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guids }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    await downloadBlob(res, "edd-metadata.csv");
  },
};

async function downloadBlob(res: Response, fallbackName: string): Promise<void> {
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
