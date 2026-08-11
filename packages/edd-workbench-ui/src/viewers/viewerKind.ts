export type ViewerKind = "native-pdf" | "native-image" | "native-text" | "email" | "docx" | "xlsx" | "pptx" | "extracted-text" | "unsupported";

/** Maps a document's server-detected content type to which viewer component should render it. */
export function viewerKindFor(contentType: string): ViewerKind {
  switch (contentType) {
    case "pdf":
      return "native-pdf";
    case "image":
      return "native-image";
    case "text":
      // Raw .txt uploads have no server-side extraction (there's nothing to
      // extract) — this fetches the original bytes via view-url, unlike
      // "extracted-text" below.
      return "native-text";
    case "eml":
    case "msg":
      return "email";
    case "docx":
      return "docx";
    case "xlsx":
    case "csv":
      // .csv shares xlsx's exact extractor and metadata shape (`{sheets}`)
      // — see ingest.ts's shared xlsx/csv branch — so it reuses the same
      // viewer with no extra code.
      return "xlsx";
    case "pptx":
      return "pptx";
    case "doc":
    case "rtf":
    case "odt":
    case "ods":
    case "odp":
    case "epub":
    case "html":
      // Already extracted to plain text at ingest time (officeText.ts /
      // doc.ts) and stored in metadata — rendered straight from there, no
      // view-url fetch, same "extract once, render from metadata" pattern
      // docx/xlsx already use. Distinct from native-text: that kind has
      // nothing pre-extracted and must fetch the raw file itself.
      return "extracted-text";
    default:
      return "unsupported";
  }
}
