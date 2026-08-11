import type { AskResult, DocumentDetail, DocumentSummary, Matter, Tag } from "./types";

const baseUrl = import.meta.env.VITE_CLOUD_API_BASE_URL;

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API request failed: ${status}${describeBody(body)}`);
  }
}

// The server's error/detail fields were being captured in .body but never
// reaching the user - every failure just showed "API request failed: 500"
// regardless of what the server actually said, forcing a CloudWatch lookup
// every time. Fold whatever detail is available into .message instead.
function describeBody(body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const parts = [b.error, b.detail].filter((v) => typeof v === "string" && v.length > 0);
    if (parts.length > 0) return ` - ${parts.join(": ")}`;
  }
  if (typeof body === "string" && body.trim()) return ` - ${body.trim().slice(0, 200)}`;
  return "";
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    // Response bodies can only be read once - res.json() consumes the
    // stream even when parsing fails, so a res.text() fallback in the catch
    // always threw "body stream already read" instead of surfacing the
    // real error. Read as text once, then try to parse that.
    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // not JSON - keep the raw text
    }
    throw new ApiError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listMatters: (token: string) => request<Matter[]>(token, "/matters"),

  createMatter: (token: string, name: string, groupId: string) =>
    request<Matter>(token, "/matters", { method: "POST", body: JSON.stringify({ name, groupId }) }),

  listGroups: (token: string) => request<Array<{ id: string; name: string; created_at: string }>>(token, "/groups"),

  listDocuments: (token: string, matterId: string) =>
    request<DocumentSummary[]>(token, `/matters/${matterId}/documents`),

  searchDocuments: (token: string, matterId: string, q: string) =>
    request<DocumentSummary[]>(token, `/matters/${matterId}/documents/search?q=${encodeURIComponent(q)}`),

  getDocument: (token: string, documentId: string) => request<DocumentDetail>(token, `/documents/${documentId}`),

  uploadDocument: (token: string, matterId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<DocumentSummary>(token, `/matters/${matterId}/documents`, { method: "POST", body: form });
  },

  getDownloadUrl: (token: string, documentId: string) =>
    request<{ url: string; expiresInSeconds: number }>(token, `/documents/${documentId}/download-url`, {
      method: "POST",
    }),

  listTags: (token: string) => request<Tag[]>(token, "/tags"),

  createTag: (token: string, name: string, color?: string) =>
    request<Tag>(token, "/tags", { method: "POST", body: JSON.stringify({ name, color }) }),

  applyTag: (token: string, documentId: string, tagId: string) =>
    request<void>(token, `/documents/${documentId}/tags`, { method: "POST", body: JSON.stringify({ tagId }) }),

  removeTag: (token: string, documentId: string, tagId: string) =>
    request<void>(token, `/documents/${documentId}/tags/${tagId}`, { method: "DELETE" }),

  ask: (token: string, matterId: string, question: string) =>
    request<AskResult>(token, `/matters/${matterId}/ask`, { method: "POST", body: JSON.stringify({ question }) }),
};
