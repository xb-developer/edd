// Mirrors cloud-backend's actual response shapes (src/routes/*.ts) —
// deliberately smaller than the desktop app's DocumentDTO (client/src/types.ts):
// no title/author/subject/family fields, because the extraction pipeline
// built so far (cloud-backend/src/extraction/extract.ts) doesn't populate
// them yet. Don't add fields here the backend doesn't actually send.

export interface Matter {
  id: string;
  name: string;
  group_id: string;
  created_by_user_id: string;
  created_at: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
}

export interface DocumentSummary {
  id: string;
  guid: string;
  filename: string;
  status: "pending_extraction" | "extracted" | "extraction_failed";
  size_bytes: string | number;
  created_at: string;
  tags: Tag[];
}

export interface DocumentDetail extends Omit<DocumentSummary, "tags"> {
  matter_id: string;
  extracted_text: string | null;
  extraction_error: string | null;
  tags: Tag[];
}

export interface Citation {
  documentId: string;
  guid: string;
  filename: string;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
}
