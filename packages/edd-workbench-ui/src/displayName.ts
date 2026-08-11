import type { DocumentDTO } from "./types";

function isEmailExt(extension: string): boolean {
  const ext = extension.toLowerCase();
  return ext === "eml" || ext === "msg";
}

/** Prefers the email's subject line (title) over the raw uploaded filename for .eml/.msg — ports the POC's own displayName.ts. Every other type shows its filename unchanged. */
export function displayName(doc: DocumentDTO): string {
  if (isEmailExt(doc.extension) && doc.title) return doc.title;
  return doc.originalFilename;
}
