import type { BundleStructureNode } from "../types.js";
import { collectDocuments } from "./treeUtils.js";

/**
 * Sequential 1-based document number within a bundle set, in page order.
 * Recomputed fresh every time — this is a positional property of the
 * document's place in the bundle, not something baked into the title text,
 * so it never goes stale the way a hand-numbered list would.
 */
export function computeDocNumbers(bundleSet: BundleStructureNode): Map<string, number> {
  const docs = collectDocuments(bundleSet).sort((a, b) => a.startPage - b.startPage);
  const map = new Map<string, number>();
  docs.forEach((d, i) => map.set(d.id, i + 1));
  return map;
}

/** Combines a resolved name/date/number into the display form "N. Name - Date" (whichever parts are present). */
export function renumberedTitle(name: string, date: string | null, number: number | undefined): string {
  const base = date ? `${name} - ${date}` : name;
  return number != null ? `${number}. ${base}` : base;
}
