import { randomUUID } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { Router } from "express";
import {
  exportBundle,
  openBundleFile,
  type AssemblyPlan,
  type PlanBundle,
  type PlanTab,
  type PlanTabChild,
} from "@xbundle/bundle-format";
import { db, type BundleRow, type DocumentRow, type TabRow } from "../db.js";
import { loadCaseHeadingConfig } from "./caseHeading.js";

export const assemblyRouter = Router();

interface DocumentDTO {
  id: string;
  title: string;
  date: string | null;
  sourcePath: string;
  pageCount: number;
  displayOrder: number;
}

interface TabDTO {
  id: string;
  title: string;
  displayOrder: number;
  documents: DocumentDTO[];
  /** Nested sub-tabs, to any depth. Kept as a separate array from `documents` rather than one merged list — `displayOrder` on both is what a caller needing the true interleaved order (e.g. building an export plan) merge-sorts on. */
  tabs: TabDTO[];
}

function toDocumentDTO(row: DocumentRow): DocumentDTO {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    sourcePath: row.source_path,
    pageCount: row.page_count,
    displayOrder: row.display_order,
  };
}

// Shared by document-assign and sub-tab-creation: a tab's documents and
// sub-tabs share one interleaved order space, so "next order" for either
// kind has to look at both siblings, not just siblings of its own kind —
// otherwise a newly assigned document could collide with (or always sort
// before) an existing sub-tab's order instead of appending after it.
function nextChildOrder(tabId: string | null): number {
  if (tabId === null) {
    const row = db.prepare("SELECT MAX(display_order) as maxOrder FROM documents WHERE tab_id IS NULL").get() as {
      maxOrder: number | null;
    };
    return (row.maxOrder ?? -1) + 1;
  }
  const docRow = db.prepare("SELECT MAX(display_order) as maxOrder FROM documents WHERE tab_id = ?").get(tabId) as {
    maxOrder: number | null;
  };
  const tabRow = db.prepare("SELECT MAX(display_order) as maxOrder FROM tabs WHERE parent_tab_id = ?").get(tabId) as {
    maxOrder: number | null;
  };
  return Math.max(docRow.maxOrder ?? -1, tabRow.maxOrder ?? -1) + 1;
}

function buildAssemblyView() {
  const bundles = db.prepare("SELECT * FROM bundles ORDER BY display_order").all() as unknown as BundleRow[];
  const tabs = db.prepare("SELECT * FROM tabs ORDER BY display_order").all() as unknown as TabRow[];
  const documents = db.prepare("SELECT * FROM documents ORDER BY display_order").all() as unknown as DocumentRow[];

  const topTabsByBundle = new Map<string, TabRow[]>();
  const subTabsByParent = new Map<string, TabRow[]>();
  for (const tab of tabs) {
    if (tab.parent_tab_id === null) {
      if (!topTabsByBundle.has(tab.bundle_id)) topTabsByBundle.set(tab.bundle_id, []);
      topTabsByBundle.get(tab.bundle_id)!.push(tab);
    } else {
      if (!subTabsByParent.has(tab.parent_tab_id)) subTabsByParent.set(tab.parent_tab_id, []);
      subTabsByParent.get(tab.parent_tab_id)!.push(tab);
    }
  }

  const docsByTab = new Map<string, DocumentRow[]>();
  const staging: DocumentRow[] = [];
  for (const doc of documents) {
    if (doc.tab_id === null) {
      staging.push(doc);
    } else {
      if (!docsByTab.has(doc.tab_id)) docsByTab.set(doc.tab_id, []);
      docsByTab.get(doc.tab_id)!.push(doc);
    }
  }

  function buildTabDTO(tab: TabRow): TabDTO {
    return {
      id: tab.id,
      title: tab.title,
      displayOrder: tab.display_order,
      documents: (docsByTab.get(tab.id) ?? []).map(toDocumentDTO),
      tabs: (subTabsByParent.get(tab.id) ?? []).map(buildTabDTO),
    };
  }

  return {
    bundles: bundles.map((b) => ({
      id: b.id,
      title: b.title,
      label: b.label,
      tabs: (topTabsByBundle.get(b.id) ?? []).map(buildTabDTO),
    })),
    staging: staging.map(toDocumentDTO),
  };
}

assemblyRouter.get("/", (_req, res) => {
  res.json(buildAssemblyView());
});

// Reconstructs a previously-exported (or any real) bundle PDF's full
// bundle/tab/document structure into the current assembly, additively —
// same as a plain document import, Assemble has no separate "projects"
// concept, just one ongoing assembly. See openBundleFile for how each
// document is physically split out of the source bundle and how
// title/date are resolved (bookmark + the bundle's own printed Index
// table).
assemblyRouter.post("/open-bundle", async (req, res) => {
  const { filePath, destFolder } = req.body as { filePath?: string; destFolder?: string };
  if (!filePath || !destFolder) {
    res.status(400).json({ error: "filePath and destFolder are required" });
    return;
  }

  let result: Awaited<ReturnType<typeof openBundleFile>>;
  try {
    result = await openBundleFile(filePath, destFolder);
  } catch (err) {
    console.error("Open bundle failed:", err);
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const bundleOrderRow = db.prepare("SELECT MAX(display_order) as maxOrder FROM bundles").get() as {
    maxOrder: number | null;
  };
  let nextBundleOrder = (bundleOrderRow.maxOrder ?? -1) + 1;

  // Inserts a tab (at the given order under the given parent) and its
  // `children` — documents and nested sub-tabs, already in the correct
  // interleaved order coming out of openBundleFile — recursing for a nested
  // sub-tab with the new tab's own id as its parent.
  function insertTab(bundleId: string, tab: PlanTab, parentTabId: string | null, order: number): void {
    const tabId = randomUUID();
    db.prepare("INSERT INTO tabs (id, bundle_id, title, display_order, parent_tab_id) VALUES (?, ?, ?, ?, ?)").run(
      tabId,
      bundleId,
      tab.title,
      order,
      parentTabId,
    );
    tab.children.forEach((child: PlanTabChild, childOrder) => {
      if (child.kind === "document") {
        const doc = child.document;
        db.prepare(
          "INSERT INTO documents (id, title, date, source_path, page_count, tab_id, display_order, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(randomUUID(), doc.title, doc.date, doc.sourcePath, doc.pageCount, tabId, childOrder, new Date().toISOString());
      } else {
        insertTab(bundleId, child.tab, tabId, childOrder);
      }
    });
  }

  for (const bundle of result.bundles) {
    const bundleId = randomUUID();
    db.prepare("INSERT INTO bundles (id, title, label, display_order) VALUES (?, '', ?, ?)").run(
      bundleId,
      bundle.label,
      nextBundleOrder,
    );
    nextBundleOrder += 1;

    bundle.tabs.forEach((tab, tabOrder) => insertTab(bundleId, tab, null, tabOrder));
  }

  res.status(201).json(buildAssemblyView());
});

// `label` (the short citation prefix, e.g. "A") is the only thing set at
// creation, matching the form's original "New bundle letter/name" intent —
// the full descriptive `title` starts empty and is set later via the
// separate title-editing PATCH.
assemblyRouter.post("/bundles", (req, res) => {
  const { label } = req.body as { label?: string };
  const row = db.prepare("SELECT MAX(display_order) as maxOrder FROM bundles").get() as { maxOrder: number | null };
  const id = randomUUID();
  db.prepare("INSERT INTO bundles (id, title, label, display_order) VALUES (?, '', ?, ?)").run(
    id,
    label ?? "",
    (row.maxOrder ?? -1) + 1,
  );
  res.status(201).json(buildAssemblyView());
});

// Updates whichever of title (full display name) / label (short citation
// prefix) is provided — kept as two independent optional fields rather than
// always overwriting both, so editing one never clobbers the other.
assemblyRouter.patch("/bundles/:id", (req, res) => {
  const { title, label } = req.body as { title?: string; label?: string };
  const existing = db.prepare("SELECT * FROM bundles WHERE id = ?").get(req.params.id) as BundleRow | undefined;
  if (!existing) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }
  db.prepare("UPDATE bundles SET title = ?, label = ? WHERE id = ?").run(
    title !== undefined ? title : existing.title,
    label !== undefined ? label : existing.label,
    req.params.id,
  );
  res.json(buildAssemblyView());
});

// Deletes a bundle and its tabs; documents inside return to the staging pool
// rather than being discarded (mirrors old Assemble's behaviour). Done as
// explicit application-level steps rather than relying on SQLite FK cascade
// behaviour in node:sqlite, which hasn't been separately verified.
assemblyRouter.delete("/bundles/:id", (req, res) => {
  const tabIds = (db.prepare("SELECT id FROM tabs WHERE bundle_id = ?").all(req.params.id) as { id: string }[]).map(
    (r) => r.id,
  );
  for (const tabId of tabIds) {
    db.prepare("UPDATE documents SET tab_id = NULL WHERE tab_id = ?").run(tabId);
  }
  db.prepare("DELETE FROM tabs WHERE bundle_id = ?").run(req.params.id);
  db.prepare("DELETE FROM bundles WHERE id = ?").run(req.params.id);
  res.json(buildAssemblyView());
});

assemblyRouter.post("/bundles/reorder", (req, res) => {
  const { orderedIds } = req.body as { orderedIds: string[] };
  orderedIds.forEach((id, i) => db.prepare("UPDATE bundles SET display_order = ? WHERE id = ?").run(i, id));
  res.json(buildAssemblyView());
});

assemblyRouter.post("/bundles/:bundleId/tabs", (req, res) => {
  const { title } = req.body as { title?: string };
  const row = db.prepare("SELECT MAX(display_order) as maxOrder FROM tabs WHERE bundle_id = ? AND parent_tab_id IS NULL").get(
    req.params.bundleId,
  ) as { maxOrder: number | null };
  const id = randomUUID();
  db.prepare("INSERT INTO tabs (id, bundle_id, title, display_order, parent_tab_id) VALUES (?, ?, ?, ?, NULL)").run(
    id,
    req.params.bundleId,
    title ?? "",
    (row.maxOrder ?? -1) + 1,
  );
  res.status(201).json(buildAssemblyView());
});

// Creates a sub-tab nested inside an existing tab, to any depth — the
// parent's own bundle_id is looked up server-side so the caller only needs
// the parent tab's id, not the bundle it happens to live in.
assemblyRouter.post("/tabs/:tabId/subtabs", (req, res) => {
  const { title } = req.body as { title?: string };
  const parent = db.prepare("SELECT * FROM tabs WHERE id = ?").get(req.params.tabId) as TabRow | undefined;
  if (!parent) {
    res.status(404).json({ error: "Parent tab not found" });
    return;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO tabs (id, bundle_id, title, display_order, parent_tab_id) VALUES (?, ?, ?, ?, ?)").run(
    id,
    parent.bundle_id,
    title ?? "",
    nextChildOrder(parent.id),
    parent.id,
  );
  res.status(201).json(buildAssemblyView());
});

assemblyRouter.delete("/tabs/:id", (req, res) => {
  db.prepare("UPDATE documents SET tab_id = NULL WHERE tab_id = ?").run(req.params.id);
  db.prepare("DELETE FROM tabs WHERE id = ?").run(req.params.id);
  res.json(buildAssemblyView());
});

assemblyRouter.post("/tabs/reorder", (req, res) => {
  const { orderedIds } = req.body as { orderedIds: string[] };
  orderedIds.forEach((id, i) => db.prepare("UPDATE tabs SET display_order = ? WHERE id = ?").run(i, id));
  res.json(buildAssemblyView());
});

// Assigns a document to a tab (or back to the staging pool if tabId is
// null), appending it at the end of that tab's/pool's order — sharing the
// same order space as any sibling sub-tabs (see nextChildOrder) so it
// appends after them rather than colliding with or always sorting before
// them.
assemblyRouter.post("/documents/:id/assign", (req, res) => {
  const { tabId } = req.body as { tabId: string | null };
  const nextOrder = nextChildOrder(tabId);
  db.prepare("UPDATE documents SET tab_id = ?, display_order = ? WHERE id = ?").run(
    tabId,
    nextOrder,
    req.params.id,
  );
  res.json(buildAssemblyView());
});

assemblyRouter.post("/documents/reorder", (req, res) => {
  // orderedIds are all documents within one tab (or the staging pool) in their new order.
  const { orderedIds } = req.body as { orderedIds: string[] };
  // Permutes these documents among the display_order VALUES they already
  // hold, rather than resetting to 0..N-1 — a sub-tab sharing the same
  // parent's order space (see nextChildOrder) can sit interleaved among
  // them, and resetting to small sequential integers would silently shove
  // it out of its true position instead of only reordering the documents.
  const existingOrders = orderedIds
    .map((id) => (db.prepare("SELECT display_order FROM documents WHERE id = ?").get(id) as { display_order: number }).display_order)
    .sort((a, b) => a - b);
  orderedIds.forEach((id, i) => db.prepare("UPDATE documents SET display_order = ? WHERE id = ?").run(existingOrders[i], id));
  res.json(buildAssemblyView());
});

function defaultExportPath(): string {
  const dir = path.join(homedir(), "Documents", "XBundle Assemble Exports");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `bundle-${Date.now()}.pdf`);
}

assemblyRouter.post("/export", async (req, res) => {
  const { outputPath, bundleIds } = req.body as { outputPath?: string; bundleIds?: string[] };
  const view = buildAssemblyView();

  // bundleIds omitted (rather than an empty array) means "export everything"
  // — kept for any caller that doesn't specify a selection at all; the UI
  // itself always sends an explicit list once a bundle exists.
  const selectedBundles = bundleIds ? view.bundles.filter((b) => bundleIds.includes(b.id)) : view.bundles;

  if (bundleIds && selectedBundles.length === 0) {
    res.status(400).json({ error: "No bundles selected to export." });
    return;
  }

  // Recurses into sub-tabs — a tab with no documents of its own but a
  // nested sub-tab that does have documents still counts as "has content"
  // for this check.
  function tabHasAnyDocument(tab: TabDTO): boolean {
    return tab.documents.length > 0 || tab.tabs.some(tabHasAnyDocument);
  }
  if (selectedBundles.every((b) => b.tabs.every((t) => !tabHasAnyDocument(t)))) {
    res.status(400).json({ error: "Nothing to export — no documents are organized into any bundle/tab yet." });
    return;
  }

  // Merges a tab's own documents and its nested sub-tabs into one list,
  // sorted by their shared displayOrder — the true interleaved order
  // matching how they'll be assigned page numbers and physically laid out
  // by assembleStructure()/exportBundle().
  function toPlanTab(tab: TabDTO): PlanTab {
    const docChildren = tab.documents.map((d) => ({
      order: d.displayOrder,
      child: { kind: "document", document: { title: d.title, date: d.date, sourcePath: d.sourcePath, pageCount: d.pageCount } } as PlanTabChild,
    }));
    const subTabChildren = tab.tabs.map((t) => ({
      order: t.displayOrder,
      child: { kind: "tab", tab: toPlanTab(t) } as PlanTabChild,
    }));
    const children = [...docChildren, ...subTabChildren].sort((a, b) => a.order - b.order).map((x) => x.child);
    return { title: tab.title, children };
  }

  const plan: AssemblyPlan = {
    bundles: selectedBundles.map(
      (b): PlanBundle => ({
        label: b.label,
        tabs: b.tabs.map(toPlanTab),
      }),
    ),
  };

  try {
    const target = outputPath ?? defaultExportPath();
    const heading = loadCaseHeadingConfig();
    const result = await exportBundle(plan, target, heading);
    res.json({ outputPath: result.outputPath, structure: result.structure });
  } catch (err) {
    console.error("Export failed:", err);
    res.status(500).json({ error: "Export failed", detail: (err as Error).message });
  }
});
