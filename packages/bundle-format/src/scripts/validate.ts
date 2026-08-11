import { parsePdfOutline } from "../parse/outline.js";
import { buildStructure } from "../parse/buildStructure.js";
import { exportBundle } from "../write/exportBundle.js";
import type { AssemblyPlan, PlanTab, PlanTabChild } from "../write/assembleStructure.js";
import type { CaseHeadingConfig } from "../write/caseHeading.js";
import type { BundleStructureNode } from "../types.js";

const TEST_HEADING: CaseHeadingConfig = {
  claimNoLabel: "Claim No. TEST-0001",
  courtLines: ["IN THE HIGH COURT OF JUSTICE", "BUSINESS AND PROPERTY COURTS"],
  claimants: ["TEST CLAIMANT LIMITED"],
  claimantsLabel: "Claimant",
  vLabel: "-v-",
  defendants: ["TEST DEFENDANT LIMITED"],
  defendantsLabel: "Defendant",
};

function summarize(node: BundleStructureNode, indent = ""): void {
  const rel =
    node.bundleRelativeStart !== null
      ? `${node.bundleLabel ? node.bundleLabel + "-" : ""}${node.bundleRelativeStart}` +
        (node.bundleRelativeEnd !== node.bundleRelativeStart
          ? `..${node.bundleLabel ? node.bundleLabel + "-" : ""}${node.bundleRelativeEnd}`
          : "")
      : "-";
  console.log(
    `${indent}[${node.type}] "${node.title}"${node.date ? ` (${node.date})` : ""} abs=${node.startPage}-${node.endPage} rel=${rel}`,
  );
  for (const child of node.children) summarize(child, indent + "  ");
}

async function testParse(filePath: string) {
  console.log(`\n=== PARSE: ${filePath} ===`);
  const { outline, totalPages } = await parsePdfOutline(filePath);
  const structure = buildStructure(outline, totalPages);
  console.log(`Total pages: ${totalPages}, top-level nodes: ${structure.roots.length}`);
  for (const root of structure.roots) summarize(root);
}

const SOURCE_FILES = ["doc-a.pdf", "doc-b.pdf", "doc-c.pdf"];
const SOURCE_PAGE_COUNTS: Record<string, number> = { "doc-a.pdf": 2, "doc-b.pdf": 3, "doc-c.pdf": 4 };

/** Enough tabs/documents to force the Index past 1 page (page-1 budget is ~21 rows at the default row height), genuinely exercising the counting/final two-pass logic rather than just the trivial 1-page case. */
function manyTabs(scratchDir: string, tabCount: number, docsPerTab: number): PlanTab[] {
  const tabs: PlanTab[] = [];
  for (let t = 0; t < tabCount; t++) {
    const children: PlanTabChild[] = [];
    for (let d = 0; d < docsPerTab; d++) {
      const file = SOURCE_FILES[(t * docsPerTab + d) % SOURCE_FILES.length];
      children.push({
        kind: "document",
        document: {
          title: `Tab ${t + 1} Document ${d + 1} - a reasonably long real-sounding title`,
          date: "1/1/2020",
          sourcePath: `${scratchDir}/${file}`,
          pageCount: SOURCE_PAGE_COUNTS[file],
        },
      });
    }
    tabs.push({ title: `Tab ${t + 1}`, children });
  }
  return tabs;
}

async function testExportRoundTrip(scratchDir: string, outPath: string) {
  console.log(`\n=== EXPORT ROUND-TRIP ===`);
  const plan: AssemblyPlan = {
    bundles: [
      { label: "A", tabs: manyTabs(scratchDir, 5, 5) },
      {
        label: "B",
        tabs: [
          {
            title: "Correspondence",
            children: [
              { kind: "document", document: { title: "Letter one", date: "1/1/2020", sourcePath: `${scratchDir}/doc-a.pdf`, pageCount: 2 } },
            ],
          },
        ],
      },
    ],
  };

  const { structure } = await exportBundle(plan, outPath, TEST_HEADING);
  console.log(`Exported to ${outPath}, total pages: ${structure.totalPages}`);
  for (const root of structure.roots) summarize(root);

  console.log("\n--- Re-parsing exported file to confirm round-trip ---");
  await testParse(outPath);
}

async function main() {
  const humphreyPath =
    "C:/Users/MarkAgombar-XBundle/Claude/Create project/stratum-app/output/humphrey-v3.pdf";
  await testParse(humphreyPath);

  const scratchDir = process.argv[2];
  const outPath = process.argv[3];
  if (scratchDir && outPath) {
    await testExportRoundTrip(scratchDir, outPath);
  } else {
    console.log("\n(skipping export round-trip test — pass <scratchDir> <outPath> to run it)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
