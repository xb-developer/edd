import type { DocumentDTO } from "../types";

export function isEmailExt(extension: string): boolean {
  const ext = extension.toLowerCase();
  return ext === "eml" || ext === "msg";
}

export function displayName(doc: DocumentDTO): string {
  if (isEmailExt(doc.extension) && doc.title) return doc.title;
  return doc.originalName;
}
