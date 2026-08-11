import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { parsePdfOutline } from "./outline.js";
import { buildStructure } from "./buildStructure.js";
import { applyIndexTableOverrides, collectByType } from "./applyIndexTableOverrides.js";
import type { BundleStructureNode } from "../types.js";
import type { PlanBundle, PlanDocument, PlanTab, PlanTabChild } from "../write/assembleStructure.js";

export interface OpenBundleResult {
  bundles: PlanBundle[];
}

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

function sanitizeFilename(title: string): string {
  const cleaned = title.replace(INVALID_FILENAME_CHARS, "_").trim();
  return (cleaned.length > 0 ? cleaned : "document").slice(0, 120);
}

/** Picks a filename that doesn't collide with one already written this run, or one already sitting in destFolder from an earlier "open bundle" into the same folder. */
function uniqueFilePath(destFolder: string, title: string, usedNames: Set<string>): string {
  const base = sanitizeFilename(title);
  let candidate = `${base}.pdf`;
  let n = 2;
  while (usedNames.has(candidate.toLowerCase()) || existsSync(path.join(destFolder, candidate))) {
    candidate = `${base}-${n}.pdf`;
    n += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return path.join(destFolder, candidate);
}

/** Extracts one document leaf's page range out of the source bundle into its own standalone PDF — required because the export pipeline (exportBundle.ts) copies a document's *entire* source file, with no concept of a page range within a bigger one. */
async function extractDocument(
  srcPdf: PDFDocument,
  node: BundleStructureNode,
  destFolder: string,
  usedNames: Set<string>,
): Promise<PlanDocument> {
  const outDoc = await PDFDocument.create();
  const pageIndices = Array.from({ length: node.endPage - node.startPage + 1 }, (_, i) => node.startPage + i);
  const copiedPages = await outDoc.copyPages(srcPdf, pageIndices);
  for (const page of copiedPages) outDoc.addPage(page);
  const bytes = await outDoc.save();
  const filePath = uniqueFilePath(destFolder, node.title, usedNames);
  await writeFile(filePath, bytes);
  return { title: node.title, date: node.date, sourcePath: filePath, pageCount: copiedPages.length };
}

/**
 * Opens an already-built bundle PDF and reconstructs it as an AssemblyPlan-
 * shaped result (the same PlanBundle/PlanTab/PlanDocument shape exportBundle
 * already consumes), so a bundle exported earlier — by Assemble itself, by
 * Create/Stratum, or by any other tool that produces a real bookmark
 * structure — can be brought back in and kept organizing.
 *
 * Splits every document leaf out into its own standalone PDF under
 * destFolder (see extractDocument), and reads the bundle's own printed
 * Index table (applyIndexTableOverrides) for title/date, the same reliable
 * source of truth Create/Stratum uses — bookmark titles alone have been
 * unreliable for dates on bundles built by other tools.
 *
 * A bundleSet's own bookmark title *is* its short `label` (see
 * assembleStructure.ts's PlanBundle.label doc comment) — the full
 * descriptive `title` is an Assemble-only concept that never enters the
 * exported file, so it can't be recovered here and is left for the user to
 * fill in, same as a freshly created bundle. A document sitting directly
 * under a bundleSet with no tab wrapper (a flat/untabbed bundle, or a
 * third-party bundle with no tab structure) is collected into one
 * synthesized untitled tab appended last, since this schema has no
 * "document directly in a bundle" concept. A tab nested inside another tab
 * (to any depth) is preserved as a nested PlanTab, not flattened into its
 * parent — see buildTabNode below.
 */
export async function openBundleFile(filePath: string, destFolder: string): Promise<OpenBundleResult> {
  const { outline, totalPages } = await parsePdfOutline(filePath);
  let structure = buildStructure(outline, totalPages);

  // Collected recursively, not just from structure.roots directly — a real
  // bundle has been seen with its lettered bundle sets nested one level
  // deeper than usual, under an extra wrapping "version label" container
  // that isn't itself a bundleSet.
  const findBundleSets = (s: typeof structure): BundleStructureNode[] => {
    const out: BundleStructureNode[] = [];
    for (const root of s.roots) collectByType(root, "bundleSet", out);
    return out;
  };

  if (findBundleSets(structure).length === 0) {
    throw new Error("This PDF doesn't look like a built bundle — no bookmark structure was found.");
  }

  const sourceBytes = await readFile(filePath);
  structure = await applyIndexTableOverrides(structure, sourceBytes);

  await mkdir(destFolder, { recursive: true });
  const srcPdf = await PDFDocument.load(sourceBytes);
  const usedNames = new Set<string>();

  // Builds one tab's PlanTab, walking its children in order — a document
  // becomes a document child, a nested section becomes a nested tab child
  // (recursing to any depth), preserving whatever interleaving the source
  // bundle actually has rather than flattening every descendant document up
  // into the outermost tab and discarding the sub-tab's own identity.
  async function buildTabNode(node: BundleStructureNode): Promise<PlanTab> {
    const children: PlanTabChild[] = [];
    for (const child of node.children) {
      if (child.type === "index") continue;
      if (child.type === "document") {
        const document = await extractDocument(srcPdf, child, destFolder, usedNames);
        children.push({ kind: "document", document });
      } else if (child.type === "section") {
        children.push({ kind: "tab", tab: await buildTabNode(child) });
      }
    }
    return { title: node.title, children };
  }

  const bundles: PlanBundle[] = [];
  for (const bundleSet of findBundleSets(structure)) {
    const tabs: PlanTab[] = [];
    const orphanDocChildren: PlanTabChild[] = [];

    for (const child of bundleSet.children) {
      if (child.type === "index") continue;
      if (child.type === "document") {
        const document = await extractDocument(srcPdf, child, destFolder, usedNames);
        orphanDocChildren.push({ kind: "document", document });
        continue;
      }
      tabs.push(await buildTabNode(child));
    }

    if (orphanDocChildren.length > 0) {
      tabs.push({ title: "", children: orphanDocChildren });
    }

    bundles.push({ label: bundleSet.title, tabs });
  }

  return { bundles };
}
