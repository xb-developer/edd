import { readFile } from "node:fs/promises";
// Legacy Node build — needed for outline parsing server-side (no DOM available).
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export interface RawOutlineItem {
  title: string;
  pageIndex: number;
  children: RawOutlineItem[];
}

export interface ParsedOutline {
  outline: RawOutlineItem[];
  totalPages: number;
}

export async function parsePdfOutline(filePath: string): Promise<ParsedOutline> {
  const data = await readFile(filePath);
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data) });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;

  async function resolvePageIndex(dest: unknown): Promise<number> {
    let resolved = dest;
    if (typeof resolved === "string") {
      resolved = await pdf.getDestination(resolved);
    }
    if (!Array.isArray(resolved) || resolved.length === 0) return 0;
    return pdf.getPageIndex(resolved[0]);
  }

  async function walk(items: any[]): Promise<RawOutlineItem[]> {
    const out: RawOutlineItem[] = [];
    for (const item of items) {
      const pageIndex = await resolvePageIndex(item.dest);
      const children = item.items && item.items.length > 0 ? await walk(item.items) : [];
      out.push({ title: (item.title ?? "").toString(), pageIndex, children });
    }
    return out;
  }

  const rawOutline = (await pdf.getOutline()) ?? [];
  const outline = await walk(rawOutline);

  // pdfjs-dist 6.x moved destroy() off PDFDocumentProxy onto PDFDocumentLoadingTask.
  await loadingTask.destroy();

  return { outline, totalPages };
}
