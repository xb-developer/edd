import { PDFDocument, PDFName } from "pdf-lib";

/**
 * If a source PDF's `/OpenAction` is a GoTo action fitting a specific page
 * object, and that page gets removed/replaced during editing (e.g. an Index
 * rebuild), pdf-lib has no notion that `/OpenAction` exists — `removePage`
 * never updates it, leaving a GoTo action pointing at a page no longer
 * reachable from `/Pages`. A strict reader (Adobe Acrobat) flags this on
 * open as "the document's page tree contains an invalid node" — a confusing
 * but technically-accurate-enough description of "this destination isn't in
 * the tree" (root-caused in Stratum's build history via stage-by-stage
 * bisection of the export pipeline).
 *
 * Regenerates `/OpenAction` to point at whichever page is actually first now.
 * Safe to call unconditionally, even if the source had no /OpenAction at all.
 */
export function fixOpenAction(pdfDoc: PDFDocument): void {
  const context = pdfDoc.context;
  const firstPage = pdfDoc.getPage(0);
  const action = context.obj({
    Type: PDFName.of("Action"),
    S: PDFName.of("GoTo"),
    D: context.obj([firstPage.ref, PDFName.of("Fit")]),
  });
  pdfDoc.catalog.set(PDFName.of("OpenAction"), action);
}
