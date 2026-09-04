import * as XLSX from "@e965/xlsx";

export interface XlsxSheet {
  name: string;
  rows: (string | number | boolean | null)[][];
}

export interface XlsxContent {
  sheets: XlsxSheet[];
  title: string | null;
  author: string | null;
  subject: string | null;
  /** The workbook's own last-modified property (SheetJS's Props.ModifiedDate), NOT the uploaded file's browser-reported mtime. */
  modified: Date | null;
}

const NULL_CONTENT: XlsxContent = { sheets: [], title: null, author: null, subject: null, modified: null };

/**
 * Extracts every sheet's rows, plus title/author/subject, from a .xlsx/.xls
 * workbook, stored in metadata the same way eml/msg's parsed fields are —
 * extracted once at ingest time rather than re-parsed client-side. SheetJS's
 * `XLSX.read` transparently handles both OOXML (.xlsx) and legacy BIFF
 * (.xls) input via the same call, populating `workbook.Props` identically
 * for both — confirmed by round-tripping a real workbook through both
 * `bookType`s — so this one function covers both content types with no
 * format-specific branching. This used to be paired with a separate
 * `extractOfficeMetadata` (JSZip-based) call for title/author/subject, which
 * silently returned nulls for genuine .xls uploads since a BIFF binary
 * isn't a zip at all — that second call is now redundant for xlsx/xls and
 * has been dropped from the ingest handler. The try/catch matches the other
 * extractors' graceful-degradation contract, though SheetJS itself is
 * lenient enough that it rarely throws — malformed input tends to come
 * back as a degenerate one-cell sheet rather than an exception.
 */
export async function extractXlsxContent(buffer: Buffer): Promise<XlsxContent> {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheets = workbook.SheetNames.map((name) => ({
      name,
      rows: XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(workbook.Sheets[name], {
        header: 1,
        blankrows: false,
      }),
    }));
    return {
      sheets,
      title: workbook.Props?.Title ?? null,
      author: workbook.Props?.Author ?? null,
      subject: workbook.Props?.Subject ?? null,
      modified: workbook.Props?.ModifiedDate ?? null,
    };
  } catch {
    return NULL_CONTENT;
  }
}
