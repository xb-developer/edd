import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument, PDFPage, StandardFonts } from "pdf-lib";
import type { AssemblyPlan } from "./assembleStructure.js";
import { assembleStructure, flattenPlanTabDocuments } from "./assembleStructure.js";
import { buildCountingRows, buildFinalRows, paginateIndexRows, COURT_INDEX_LAYOUT } from "./indexLayout.js";
import { drawIndexPage, type Fonts } from "./indexRender.js";
import type { CaseHeadingConfig } from "./caseHeading.js";
import { writeOutline } from "./writeOutline.js";
import { writePageLabels } from "./writePageLabels.js";
import { stripPdfACompliance } from "./stripPdfA.js";
import { fixOpenAction } from "./fixOpenAction.js";
import type { BundleStructure } from "../types.js";

export interface ExportResult {
  structure: BundleStructure;
  outputPath: string;
}

/**
 * Concatenates every source document's pages into one new PDF in plan order,
 * with a real rendered Index (case heading + Order/Document/Date/Pages
 * table, hyperlinked rows) at the head of each bundle, then writes the
 * bookmark outline and /PageLabels derived from the same structure, then
 * applies the two Acrobat-compatibility fixes ported from Create/Stratum's
 * export pipeline (PDF/A metadata strip, /OpenAction fix) — without these
 * two, a strict reader like Acrobat can reject an otherwise
 * structurally-valid file. See stripPdfA.ts / fixOpenAction.ts for why.
 *
 * A bundle's own Index page count must be known before document page
 * numbers can be assigned (documents start right after the index), but the
 * index also needs to know its own row content — which doesn't actually
 * depend on final page numbers (see indexLayout.ts). So this runs in two
 * passes: a lightweight "counting" pass over the raw plan to learn each
 * bundle's index page count, then the real structure/page-number assignment,
 * then a "final" pass rebuilding the same rows (now with real page numbers)
 * to actually render.
 */
export async function exportBundle(plan: AssemblyPlan, outputPath: string, heading: CaseHeadingConfig): Promise<ExportResult> {
  const indexPageCounts = plan.bundles.map((bundle) => {
    const rows = buildCountingRows(bundle, COURT_INDEX_LAYOUT);
    return paginateIndexRows(rows, COURT_INDEX_LAYOUT).length;
  });

  const structure = assembleStructure(plan, indexPageCounts);
  const outDoc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await outDoc.embedFont(StandardFonts.Helvetica),
    bold: await outDoc.embedFont(StandardFonts.HelveticaBold),
  };

  for (let bundleIndex = 0; bundleIndex < plan.bundles.length; bundleIndex++) {
    const bundle = plan.bundles[bundleIndex];
    const bundleNode = structure.roots[bundleIndex];
    const indexPageCount = indexPageCounts[bundleIndex];

    // Reserve the index's pages up front — filled in below, after the real
    // documents (and therefore real page numbers) exist.
    const indexPages: PDFPage[] = [];
    for (let i = 0; i < indexPageCount; i++) {
      indexPages.push(outDoc.addPage([COURT_INDEX_LAYOUT.pageWidth, COURT_INDEX_LAYOUT.pageHeight]));
    }

    // flattenPlanTabDocuments walks each tab's `children` in the same order
    // assembleStructure() just used to assign page numbers above, so a
    // document's physical position here always matches the page number
    // printed for it in the Index/outline — including through any nested
    // sub-tabs.
    for (const tab of bundle.tabs) {
      for (const doc of flattenPlanTabDocuments(tab)) {
        const bytes = await readFile(doc.sourcePath);
        const srcDoc = await PDFDocument.load(bytes);
        const pageIndices = srcDoc.getPageIndices();
        const copiedPages = await outDoc.copyPages(srcDoc, pageIndices);
        for (const page of copiedPages) outDoc.addPage(page);
      }
    }

    const finalRows = buildFinalRows(bundleNode, COURT_INDEX_LAYOUT);
    const finalPages = paginateIndexRows(finalRows, COURT_INDEX_LAYOUT);
    if (finalPages.length !== indexPageCount) {
      // Row height never depends on page-range text (see indexLayout.ts), so
      // this should be unreachable — fail loudly rather than silently render
      // onto the wrong number of reserved pages if that assumption ever breaks.
      throw new Error(
        `Index page count mismatch for bundle "${bundle.label}": counting pass reserved ${indexPageCount} page(s), final pass produced ${finalPages.length}.`,
      );
    }

    finalPages.forEach((rows, i) => {
      drawIndexPage(
        indexPages[i],
        fonts,
        { bundleLabel: bundle.label, heading, rows, pageNumber: i + 1, totalPages: finalPages.length },
        COURT_INDEX_LAYOUT,
      );
    });
  }

  writeOutline(outDoc, structure);
  writePageLabels(outDoc, structure);
  stripPdfACompliance(outDoc);
  fixOpenAction(outDoc);

  const finalBytes = await outDoc.save({ useObjectStreams: false });
  await writeFile(outputPath, finalBytes);

  return { structure, outputPath };
}
