// Self-hosted Elasticsearch (see infra/edd-workbench/lib/edd-workbench-stack.ts's
// ElasticsearchService) — always on, unlike the GPU-backed embedding/
// generation services, so there's no business-hours schedule to work around
// here.
const INDEX_NAME = "edd-workbench-documents";

function serviceUrl(): string {
  const url = process.env.ELASTICSEARCH_SERVICE_URL;
  if (!url) {
    throw new Error("ELASTICSEARCH_SERVICE_URL environment variable is required");
  }
  return url;
}

export interface SearchDocument {
  documentId: string;
  orgId: string;
  matterId: string;
  filename: string;
  extension: string;
  guid: string;
  body: string;
}

/**
 * Upserts one document's search entry — PUT with an explicit _id (the
 * Postgres documentId) is create-or-replace in one call, which is exactly
 * what's needed for both the ingest-time create and the post-OCR update to
 * be the same idempotent operation, no separate code paths.
 */
export async function indexDocument(doc: SearchDocument): Promise<void> {
  const res = await fetch(`${serviceUrl()}/${INDEX_NAME}/_doc/${doc.documentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      org_id: doc.orgId,
      matter_id: doc.matterId,
      filename: doc.filename,
      extension: doc.extension,
      guid: doc.guid,
      body: doc.body,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Search index request failed: ${res.status} ${body}`);
  }
}

/** Best-effort from every caller's point of view — a 404 (already gone, or never indexed) is not an error here. */
export async function deleteDocumentFromIndex(documentId: string): Promise<void> {
  const res = await fetch(`${serviceUrl()}/${INDEX_NAME}/_doc/${documentId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`Search index delete failed: ${res.status} ${body}`);
  }
}

export interface SearchResult {
  documentIds: string[];
  totalHits: number;
}

/**
 * Both org_id and matter_id are filtered — matter_id alone is
 * authorization-safe today only because the caller (search.ts) sits behind
 * requireMatterAccess(), but Elasticsearch has no RLS equivalent the way
 * Postgres does, so a second org_id filter is free defense-in-depth against
 * a future bug in this query or a future caller that skips that gate.
 *
 * Filters against `org_id.keyword`/`matter_id.keyword`, NOT the bare field
 * names — no explicit index mapping is created anywhere (indexDocument just
 * PUTs a plain JSON doc), so Elasticsearch's default dynamic mapping gives
 * every string field `type: text` (analyzed) plus an auto-generated
 * `.keyword` sub-field (exact match, unanalyzed). A `term` query against
 * the bare `org_id`/`matter_id` field name matches against the ANALYZED
 * text — the standard analyzer lowercases and splits on non-letter
 * characters, so a UUID's hyphens or an "org_..." id's underscore mean the
 * indexed tokens never equal the whole original string, and the filter
 * always excludes every real document. Confirmed live: `match_all` found
 * real indexed docs, but this exact filter shape returned zero for a real
 * org/matter pair with real documents in it — a term query needs the
 * `.keyword` sub-field for this to ever match anything.
 *
 * simple_query_string (not the stricter query_string) never throws on
 * malformed input — it does best-effort parsing of +/-/|/"phrase"/*
 * syntax, which is the boolean/phrase-exact behavior asked for without any
 * custom query-language parsing of our own. default_operator: OR (not AND)
 * — for an eDiscovery tool, silently ANDing bare words together risks
 * under-recall (missing a responsive document), a worse failure than
 * over-recall; a reviewer typing several bare words expects "any of these,"
 * narrowing explicitly with +word/"phrase" syntax when they want it.
 *
 * track_total_hits + returning totalHits alongside the (possibly
 * size-capped) documentIds lets the caller tell "these are all the matches"
 * from "there were more than we returned" — a silent cap with no signal
 * would be its own silent-hit-loss bug in a legal search tool.
 */
export async function searchDocuments(orgId: string, matterId: string, query: string, maxResults = 5000): Promise<SearchResult> {
  const res = await fetch(`${serviceUrl()}/${INDEX_NAME}/_search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: {
        bool: {
          filter: [{ term: { "org_id.keyword": orgId } }, { term: { "matter_id.keyword": matterId } }],
          must: [{ simple_query_string: { query, fields: ["body", "filename"], default_operator: "OR" } }],
        },
      },
      track_total_hits: true,
      _source: false,
      size: maxResults,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Search request failed: ${res.status} ${body}`);
  }

  const { hits } = (await res.json()) as { hits: { total: { value: number }; hits: { _id: string }[] } };
  return { documentIds: hits.hits.map((h) => h._id), totalHits: hits.total.value };
}

/** Live document count in the index for one org — the basis for the admin-visible health check (compares this against that org's own Postgres ready/failed document count). Scoped, not a whole-index total, since an admin cares about their own org's data being fully indexed, not some other org's. Filters on `org_id.keyword` — see searchDocuments's own comment for why the bare (dynamically-mapped, analyzed) field name would never match. */
export async function getIndexHealth(orgId: string): Promise<{ docCount: number }> {
  const res = await fetch(`${serviceUrl()}/${INDEX_NAME}/_count`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: { term: { "org_id.keyword": orgId } } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Search index count failed: ${res.status} ${body}`);
  }
  const { count } = (await res.json()) as { count: number };
  return { docCount: count };
}
