import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api";
import type { DocumentDTO } from "./types";

/**
 * Resolves the FULL row (including `metadata`) for whichever document is
 * currently selected.
 *
 * The list endpoint deliberately omits `metadata` — it's a jsonb holding a
 * document's whole extracted content (mammoth HTML, a PDF's full text
 * layer, every row of an xlsx), so including it made a matter's first load
 * carry the entire matter's extracted text. Only the selected document
 * ever needs it: DocumentViewer renders eml/msg/docx/xlsx/text straight
 * out of it, and DocumentPropertiesPanel reads it too.
 *
 * Cached per document id for the lifetime of the open matter, so arrowing
 * back and forth through a family (or re-selecting a row) costs one fetch
 * per document, not one per click. The cache is a ref, not state — writing
 * to it must not itself trigger a render.
 *
 * `listDocument` is returned immediately while the fetch is in flight, so
 * the viewer shows filename/status/dates without waiting; only the
 * metadata-derived body arrives late. That keeps selection feeling
 * instant, which is the one thing the previous "everything up front"
 * approach genuinely did better.
 */
export function useDocumentDetail(api: ApiClient, matterId: string, listDocument: DocumentDTO | null): DocumentDTO | null {
  const cacheRef = useRef<Map<string, DocumentDTO>>(new Map());
  const [, forceRender] = useState(0);

  // Dropped wholesale when the matter changes — ids are unique across
  // matters, but holding another matter's documents alive is a leak with
  // no upside, and this hook's own cache must not outlive the matter the
  // rest of MatterDetail's state is scoped to.
  useEffect(() => {
    cacheRef.current = new Map();
    forceRender((n) => n + 1);
  }, [matterId]);

  const documentId = listDocument?.documentId ?? null;

  useEffect(() => {
    if (!documentId || cacheRef.current.has(documentId)) return;
    let cancelled = false;
    api
      .getDocument(matterId, documentId)
      .then((full) => {
        if (cancelled) return;
        cacheRef.current.set(documentId, full);
        forceRender((n) => n + 1);
      })
      // Deliberately silent: the caller still renders the list row's own
      // fields, so a failed metadata fetch degrades to "no preview body"
      // rather than breaking selection. A real fetch failure here is
      // already surfaced by the view-url/document requests the viewer makes
      // alongside it.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, matterId, documentId]);

  if (!listDocument) return null;
  return cacheRef.current.get(listDocument.documentId) ?? listDocument;
}
