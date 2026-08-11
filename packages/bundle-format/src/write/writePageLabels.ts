import { PDFDocument, PDFName, PDFNumber, PDFString } from "pdf-lib";
import type { BundleStructure } from "../types.js";
import { findBundleSets } from "./treeUtils.js";
import { escapePdfString } from "./pdfStringEscape.js";

/**
 * Regenerates the PDF's own `/PageLabels` — a separate, formal PDF feature
 * (distinct from bookmarks) that tells a viewer's page number box/thumbnail
 * panel what to display (e.g. "A-192" instead of raw page 193 of 585): one
 * decimal-style range per bundle set, prefixed with that bundle set's own
 * title, keyed to the absolute page index each bundle set starts at.
 *
 * pdf-lib does not update this automatically when pages are inserted or
 * removed — left alone, ranges stay keyed to OLD absolute start pages, so
 * after a bundle set grows, every following bundle set's content is
 * mislabelled. Regenerating this from the same final structure used for
 * bookmarks keeps it correct for the same reason those are.
 */
export function writePageLabels(pdfDoc: PDFDocument, structure: BundleStructure): void {
  const context = pdfDoc.context;
  const bundleSets = findBundleSets(structure.roots).sort((a, b) => a.startPage - b.startPage);

  // An untitled (flat, single-set) bundle has no letter prefix at all —
  // omitting /P entirely gives a bare decimal label ("1", "2"...), matching
  // that bundle's own convention rather than a stray leading "-".
  const nums = bundleSets.flatMap((bs) => [
    PDFNumber.of(bs.startPage),
    context.obj({
      S: PDFName.of("D"),
      ...(bs.title ? { P: PDFString.of(escapePdfString(`${bs.title}-`)) } : {}),
      St: PDFNumber.of(1),
    }),
  ]);

  const pageLabelsDict = context.obj({ Nums: nums });
  pdfDoc.catalog.set(PDFName.of("PageLabels"), pageLabelsDict);
}
