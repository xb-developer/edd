import { PDFDocument, PDFName } from "pdf-lib";

/**
 * A source bundle may be declared PDF/A-1B via XMP metadata (pdfaid:part=1,
 * pdfaid:conformance=B), but structural edits — non-embedded standard-14
 * fonts, freshly rebuilt outline/link structures — don't meet PDF/A's
 * stricter rules (e.g. every font must be embedded). Adobe Acrobat runs
 * PDF/A preflight on documents that claim conformance, and reports the
 * resulting inconsistency as a generic page-tree/structure error rather
 * than a PDF/A-specific one, which made this hard to place at first when
 * it was originally found (see Stratum's build history).
 *
 * Trial bundles have no PDF/A requirement, so the fix is to stop claiming
 * conformance at all: drop the XMP metadata stream (which carries the
 * pdfaid:* declaration) and any /OutputIntents (PDF/A's required color
 * output intent), leaving an ordinary, unconstrained PDF.
 */
export function stripPdfACompliance(pdfDoc: PDFDocument): void {
  pdfDoc.catalog.delete(PDFName.of("Metadata"));
  pdfDoc.catalog.delete(PDFName.of("OutputIntents"));
}
