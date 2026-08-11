import type { BundleStructureNode } from "../types.js";

export function findBundleSets(nodes: BundleStructureNode[], out: BundleStructureNode[] = []): BundleStructureNode[] {
  for (const n of nodes) {
    if (n.type === "bundleSet") out.push(n);
    findBundleSets(n.children, out);
  }
  return out;
}

export function collectDocuments(node: BundleStructureNode, out: BundleStructureNode[] = []): BundleStructureNode[] {
  if (node.type === "document") out.push(node);
  for (const child of node.children) collectDocuments(child, out);
  return out;
}
