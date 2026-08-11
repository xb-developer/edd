import { parsePdfOutline } from "../parse/outline.js";
import { buildStructure } from "../parse/buildStructure.js";
import type { BundleStructureNode } from "../types.js";

function summarize(n: BundleStructureNode, indent = ""): void {
  console.log(`${indent}[${n.type}] ${n.title} abs=${n.startPage}-${n.endPage}`);
  n.children.forEach((c) => summarize(c, indent + "  "));
}

async function main() {
  const target = process.argv[2];
  const { outline, totalPages } = await parsePdfOutline(target);
  const s = buildStructure(outline, totalPages);
  console.log("total pages", totalPages);
  s.roots.forEach((r) => summarize(r));
}

main();
