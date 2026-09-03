import type {
  MatterDTO,
  DocumentDTO,
  TagSetDTO,
  TagDTO,
  InitUploadFileDTO,
  InitUploadResultDTO,
  ExportJobDTO,
  MatterMemberDTO,
  MatterMemberCandidateDTO,
  WorkerStatusDTO,
  AskResultDTO,
  AiUsageDTO,
  SearchResultDTO,
  SearchHealthDTO,
} from "./types";

/**
 * `getAccessToken` is the one capability the browser host must inject — the
 * direct replacement for Assemble's native-picker props (see AssembleWorkspace
 * in @xbundle/assemble-ui): there's no second host to abstract file-picking
 * over here, but every request still needs a fresh Auth0 bearer token.
 */
/** Carries the real HTTP status alongside the message — needed by callers that must tell "unauthorized" apart from any other failure (e.g. the pop-out viewer window's session-expired state) rather than string-matching an error message. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export function createApiClient(baseUrl: string, getAccessToken: () => Promise<string>) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await getAccessToken();
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(body.error ?? `Request failed: ${res.status}`, res.status);
    }
    // 204 (delete) has no body at all — calling .json() on it throws.
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  return {
    /** The caller's own local identity — userId/role aren't otherwise knowable client-side (Auth0 only ever exposes sub/email). */
    getMe: () => request<{ userId: string; orgId: string; role: string; email: string }>("/me"),

    getMatters: () => request<MatterDTO[]>("/matters"),

    createMatter: (name: string, referenceCode?: string) =>
      request<MatterDTO>("/matters", {
        method: "POST",
        body: JSON.stringify({ name, referenceCode }),
      }),

    updateMatter: (id: string, name: string) =>
      request<MatterDTO>(`/matters/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),

    getMatterDocuments: (matterId: string) => request<DocumentDTO[]>(`/matters/${matterId}/documents`),

    getDocument: (matterId: string, documentId: string) => request<DocumentDTO>(`/matters/${matterId}/documents/${documentId}`),

    getDocumentViewUrl: (matterId: string, documentId: string) =>
      request<{ viewUrl: string }>(`/matters/${matterId}/documents/${documentId}/view-url`),

    deleteDocument: (matterId: string, documentId: string) =>
      request<void>(`/matters/${matterId}/documents/${documentId}`, { method: "DELETE" }),

    /** Rejects the whole request (deletes nothing) if any id doesn't belong to this matter — see documents.ts's own bulk DELETE route. */
    bulkDeleteDocuments: (matterId: string, documentIds: string[]) =>
      request<{ deletedCount: number }>(`/matters/${matterId}/documents`, {
        method: "DELETE",
        body: JSON.stringify({ documentIds }),
      }),

    /** Resets each document to 'pending' and re-enqueues it — rejects the whole request if any isn't currently 'failed' (see documents.ts's own retry-ingest route). */
    retryIngest: (matterId: string, documentIds: string[]) =>
      request<{ retriedCount: number }>(`/matters/${matterId}/documents/retry-ingest`, {
        method: "POST",
        body: JSON.stringify({ documentIds }),
      }),

    /** Assigns GUIDs and mints a presigned S3 PUT URL per file, in one batch — see documents.ts's init-upload route. The actual bytes never pass through this API; the caller PUTs directly to each returned uploadUrl. */
    initUpload: (matterId: string, files: InitUploadFileDTO[]) =>
      request<InitUploadResultDTO[]>(`/matters/${matterId}/documents/init-upload`, {
        method: "POST",
        body: JSON.stringify({ files }),
      }),

    /** Confirms a document's bytes have landed in S3 and enqueues it for ingest. Call only after the presigned PUT from initUpload has actually succeeded. */
    uploadComplete: (matterId: string, documentId: string) =>
      request<{ status: string }>(`/matters/${matterId}/documents/${documentId}/upload-complete`, { method: "POST" }),

    getTagSets: (matterId: string) => request<TagSetDTO[]>(`/matters/${matterId}/tags`),

    /** Creates (or reuses, if a same-name tag already exists in this matter, any casing) a matter-scoped custom code under an auto-created "Custom" tag set. */
    createCustomTag: (matterId: string, name: string) =>
      request<TagDTO>(`/matters/${matterId}/tags/custom`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),

    getDocumentTags: (matterId: string, documentId: string) =>
      request<string[]>(`/matters/${matterId}/document-tags/${documentId}`),

    /** Every document's applied tag ids in one call — backs the tag-filter panel's checkbox counts and filtering, without a per-document fetch loop. */
    getAllDocumentTags: (matterId: string) => request<Record<string, string[]>>(`/matters/${matterId}/document-tags`),

    /** documentIds is always an array — the same endpoint serves the existing single-document toggle (caller passes [documentId]) and bulk-apply (caller passes every checked id). */
    applyTag: (matterId: string, documentIds: string[], tagId: string) =>
      request<void>(`/matters/${matterId}/document-tags/apply`, {
        method: "POST",
        body: JSON.stringify({ documentIds, tagId }),
      }),

    removeTag: (matterId: string, documentIds: string[], tagId: string) =>
      request<void>(`/matters/${matterId}/document-tags/remove`, {
        method: "POST",
        body: JSON.stringify({ documentIds, tagId }),
      }),

    /** Enqueues a real export job scoped to exactly this selection (never "everything in the matter") — see exports.ts's own validation of every id against this matter before enqueueing. */
    requestExport: (matterId: string, kind: "documents" | "properties", documentIds: string[]) =>
      request<{ exportId: string; status: string }>(`/matters/${matterId}/exports`, {
        method: "POST",
        body: JSON.stringify({ kind, documentIds }),
      }),

    getExportStatus: (matterId: string, exportId: string) => request<ExportJobDTO>(`/matters/${matterId}/exports/${exportId}`),

    /** 409s until the job's status is 'ready' — callers poll getExportStatus first. */
    getExportDownloadUrl: (matterId: string, exportId: string) =>
      request<{ downloadUrl: string }>(`/matters/${matterId}/exports/${exportId}/download-url`),

    getMatterMembers: (matterId: string) => request<MatterMemberDTO[]>(`/matters/${matterId}/members`),

    /** Org members (per Auth0) who don't already have access to this matter — backs the access-list panel's "+" dropdown. */
    getMatterMemberCandidates: (matterId: string) => request<MatterMemberCandidateDTO[]>(`/matters/${matterId}/members/candidates`),

    /** Grants access immediately — no separate save step. The server creates a local user row for this Auth0 identity if one doesn't exist yet. */
    addMatterMember: (matterId: string, candidate: MatterMemberCandidateDTO) =>
      request<MatterMemberDTO>(`/matters/${matterId}/members`, {
        method: "POST",
        body: JSON.stringify(candidate),
      }),

    removeMatterMember: (matterId: string, userId: string) =>
      request<void>(`/matters/${matterId}/members/${userId}`, { method: "DELETE" }),

    /** Fire-and-forget from the caller's side — see EddWorkbenchWorkspace.tsx's selectMatter. */
    recordMatterLoad: (matterId: string) => request<void>(`/matters/${matterId}/audit-load`, { method: "POST" }),

    /** Best-effort, called right before the actual Auth0 logout redirect — never let a failure here block logout. */
    recordLogout: () => request<void>("/audit/logout", { method: "POST" }),

    /** Live queue depth plus each queue's own worker heartbeat, backing the topbar's WorkerHealthBar. Available to any authenticated caller. */
    getWorkerStatus: () => request<WorkerStatusDTO>("/worker-status"),

    /** May take several seconds (embeds the question, does a similarity search, then a real generation call) and 503s outside the self-hosted GPU services' business-hours schedule — see ask.ts. */
    askQuestion: (matterId: string, question: string) =>
      request<AskResultDTO>(`/matters/${matterId}/ask`, {
        method: "POST",
        body: JSON.stringify({ question }),
      }),

    /** The caller's own running token usage across the self-hosted AI services, broken down by call site — backs the topbar's AiUsageBadge. */
    getAiUsage: () => request<AiUsageDTO>("/ai-usage/me"),

    /** Boolean/phrase-exact full-text search over this matter's documents (self-hosted Elasticsearch — see search.ts). Empty/blank query returns no results without a real request. */
    searchDocuments: (matterId: string, query: string) =>
      request<SearchResultDTO>(`/matters/${matterId}/search?q=${encodeURIComponent(query)}`),

    /** Backs the topbar's WorkerHealthBar search-index chip. Available to any authenticated caller, scoped to their own org. */
    getSearchHealth: () => request<SearchHealthDTO>("/search-health"),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
