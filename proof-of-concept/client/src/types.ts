export interface Tag {
  id: number;
  name: string;
  color: string;
  is_custom?: number;
}

export interface DocumentDTO {
  guid: string;
  originalName: string;
  extension: string;
  sizeBytes: number;
  dateModified: string | null;
  dateCreated: string | null;
  title: string | null;
  author: string | null;
  subject: string | null;
  extra: Record<string, unknown> | null;
  importedAt: string;
  familyId: string | null;
  parentGuid: string | null;
  depth: number;
  to: string | null;
  cc: string | null;
  tags: Tag[];
}

export type PreviewPayload =
  | { kind: "html"; html: string }
  | { kind: "sheets"; sheets: Array<{ name: string; rows: string[][] }> }
  | { kind: "text"; text: string }
  | { kind: "slides"; slides: Array<{ index: number; text: string }> }
  | {
      kind: "email";
      from: string | null;
      to: string | null;
      cc: string | null;
      date: string | null;
      subject: string | null;
      bodyHtml: string | null;
      bodyText: string | null;
      attachments: Array<{ filename: string; size: number | null }>;
    }
  | { kind: "pdf" }
  | { kind: "image" }
  | { kind: "tiff"; pages: string[] }
  // A raw .html/.htm file — rendered via a sandboxed iframe pointed at the
  // file route, distinct from "html" above (mammoth-generated markup from a
  // parsed .docx, safe to render inline) since this is untrusted, arbitrary
  // content that could contain a real <script> tag.
  | { kind: "htmlFile" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

export type FilterMode = "any" | "all";

export interface MatterInfo {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}
