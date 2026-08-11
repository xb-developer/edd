import { PDFFont, PDFName, PDFNull, PDFPage, rgb } from "pdf-lib";
import type { IndexRow, IndexLayoutConfig } from "./indexLayout.js";
import { COURT_INDEX_LAYOUT } from "./indexLayout.js";
import type { CaseHeadingConfig } from "./caseHeading.js";
import { sanitizeForFont } from "./textSanitize.js";

const HEADER_GREY = rgb(0.83, 0.83, 0.83);
const TAB_BLUE = rgb(0.72, 0.81, 0.91);
const BORDER = rgb(0.5, 0.5, 0.5);
const INK = rgb(0.05, 0.05, 0.05);

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

function topY(config: IndexLayoutConfig, top: number): number {
  return config.pageHeight - top;
}

function drawRightAligned(page: PDFPage, font: PDFFont, text: string, rightEdge: number, top: number, config: IndexLayoutConfig, size: number) {
  const safe = sanitizeForFont(text, font);
  const w = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, { x: rightEdge - w, y: topY(config, top), size, font, color: INK });
}

function drawCentered(page: PDFPage, font: PDFFont, text: string, top: number, config: IndexLayoutConfig, size: number) {
  const safe = sanitizeForFont(text, font);
  const w = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, { x: (config.pageWidth - w) / 2, y: topY(config, top), size, font, color: INK });
}

/**
 * The case heading block, laid out top-to-bottom with a fixed line height
 * rather than hardcoded per-line Y coordinates — real bundles vary in
 * claimant/defendant line counts and whether there's a preamble line, so a
 * fixed-position layout breaks the moment the content shape changes. Claim
 * number is right-aligned near the top of the block; claimants/defendants
 * left-indented with their "Claimants"/"Defendants" style label
 * right-aligned on the line after; "v"/"-v-" centred between the two party
 * blocks.
 */
function drawCaseHeading(page: PDFPage, fonts: Fonts, config: IndexLayoutConfig, heading: CaseHeadingConfig) {
  const size = 11;
  const lineHeight = 22;
  let top = 56;

  drawRightAligned(page, fonts.bold, heading.claimNoLabel, config.columns.right, 34, config, size);

  const line = (text: string, x: number, underline = false) => {
    const safe = sanitizeForFont(text, fonts.bold);
    const y = topY(config, top);
    page.drawText(safe, { x, y, size, font: fonts.bold, color: INK });
    if (underline) {
      const w = fonts.bold.widthOfTextAtSize(safe, size);
      page.drawLine({ start: { x, y: y - 2 }, end: { x: x + w, y: y - 2 }, thickness: 0.6, color: INK });
    }
    top += lineHeight;
  };

  for (const l of heading.preamble ?? []) line(l, config.marginX, true);
  for (const l of heading.courtLines) line(l, config.marginX, true);
  line("BETWEEN:", config.marginX);

  const partyX = config.pageWidth * 0.44;
  for (const c of heading.claimants) line(c, partyX);
  drawRightAligned(page, fonts.bold, heading.claimantsLabel, config.columns.right, top, config, size);
  top += lineHeight;

  drawCentered(page, fonts.bold, heading.vLabel, top, config, size);
  top += lineHeight;

  for (const d of heading.defendants) line(d, partyX - 3);
  drawRightAligned(page, fonts.bold, heading.defendantsLabel, config.columns.right, top, config, size);
  top += lineHeight;
}

/**
 * Adds a full-row clickable link — `/Dest [<page ref> /FitV null]`, the same
 * destination form our bookmark outline uses, just as a page-level Link
 * annotation instead of an Outline item, so clicking anywhere on the row
 * jumps to the document's first page.
 */
function addRowLink(page: PDFPage, rect: { x: number; y: number; width: number; height: number }, targetPageIndex: number) {
  const doc = page.doc;
  const context = doc.context;
  const targetPage = doc.getPage(targetPageIndex);
  const linkDict = context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    Border: [0, 0, 0],
    Dest: context.obj([targetPage.ref, PDFName.of("FitV"), PDFNull]),
  });
  const linkRef = context.register(linkDict);
  page.node.addAnnot(linkRef);
}

/**
 * Draws one Index page: case heading (page 1 only), a grey Order/Document/
 * Date/Pages header row, one shaded full-width row per tab (a flat bundle
 * with no tabs has none), and a bordered row per document. Row heights here
 * must match indexLayout.ts's paginateIndexRows exactly, or the page count
 * reserved for the index and what actually renders could disagree.
 */
export function drawIndexPage(
  page: PDFPage,
  fonts: Fonts,
  info: { bundleLabel: string; heading: CaseHeadingConfig; rows: IndexRow[]; pageNumber: number; totalPages: number },
  config: IndexLayoutConfig = COURT_INDEX_LAYOUT,
): void {
  let top = 348;
  if (info.pageNumber === 1) {
    drawCaseHeading(page, fonts, config, info.heading);
  } else {
    top = 60;
  }

  const { columns, marginX, rowHeight, wrapLineHeight } = config;

  page.drawRectangle({
    x: marginX,
    y: topY(config, top + rowHeight),
    width: columns.right - marginX,
    height: rowHeight,
    color: HEADER_GREY,
  });
  for (const [text, x] of [
    ["Order", columns.order],
    ["Document", columns.document],
    ["Date", columns.date],
    ["Pages", columns.pages],
  ] as const) {
    page.drawText(text, { x: x + 4, y: topY(config, top + rowHeight - 5), size: 10, font: fonts.bold, color: INK });
  }

  let cursor = top + rowHeight;
  page.drawLine({
    start: { x: marginX, y: topY(config, cursor) },
    end: { x: columns.right, y: topY(config, cursor) },
    thickness: 0.5,
    color: BORDER,
  });

  for (const row of info.rows) {
    const h = row.kind === "tabHeader" ? rowHeight : rowHeight + Math.max(0, row.documentLines.length - 1) * wrapLineHeight;

    if (row.kind === "tabHeader") {
      // Indented per nesting level so a sub-tab visibly reads as nested
      // under its parent tab rather than as an unrelated sibling row.
      const indent = row.depth * 14;
      page.drawRectangle({ x: marginX, y: topY(config, cursor + h), width: columns.right - marginX, height: h, color: TAB_BLUE });
      page.drawText(sanitizeForFont(row.label, fonts.bold), { x: columns.order + 4 + indent, y: topY(config, cursor + rowHeight - 5), size: 10, font: fonts.bold, color: INK });
    } else {
      page.drawText(String(row.order), { x: columns.order + 4, y: topY(config, cursor + rowHeight - 5), size: 9.5, font: fonts.regular, color: INK });
      let lineTop = cursor + rowHeight - 5;
      for (const line of row.documentLines) {
        page.drawText(sanitizeForFont(line, fonts.regular), { x: columns.document + 4, y: topY(config, lineTop), size: config.docFontSize, font: fonts.regular, color: INK });
        lineTop += wrapLineHeight;
      }
      if (row.date) {
        page.drawText(sanitizeForFont(row.date, fonts.regular), { x: columns.date + 4, y: topY(config, cursor + rowHeight - 5), size: 9.5, font: fonts.regular, color: INK });
      }
      page.drawText(row.pageRange, { x: columns.pages + 4, y: topY(config, cursor + rowHeight - 5), size: 9.5, font: fonts.regular, color: INK });

      for (const x of [columns.document, columns.date, columns.pages]) {
        page.drawLine({ start: { x, y: topY(config, cursor + h) }, end: { x, y: topY(config, cursor) }, thickness: 0.4, color: BORDER });
      }

      addRowLink(
        page,
        { x: marginX, y: topY(config, cursor + h), width: columns.right - marginX, height: h },
        row.targetPage,
      );
    }

    cursor += h;
    page.drawLine({
      start: { x: marginX, y: topY(config, cursor) },
      end: { x: columns.right, y: topY(config, cursor) },
      thickness: 0.5,
      color: BORDER,
    });
  }

  page.drawRectangle({
    x: marginX,
    y: topY(config, cursor),
    width: columns.right - marginX,
    height: cursor - top,
    borderColor: BORDER,
    borderWidth: 0.8,
  });

  if (info.pageNumber > 1) {
    page.drawText(`(${info.pageNumber} of ${info.totalPages})`, {
      x: columns.right - fonts.regular.widthOfTextAtSize(`(${info.pageNumber} of ${info.totalPages})`, 8),
      y: topY(config, top - 10),
      size: 8,
      font: fonts.regular,
      color: rgb(0.4, 0.4, 0.4),
    });
  }
}
