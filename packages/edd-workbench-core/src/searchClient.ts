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

// Elasticsearch's own default http.max_content_length is 100mb; at roughly
// 80 bytes per delete action line this could be far larger, but a bounded
// chunk keeps one failed request from losing an unbounded amount of work
// and keeps the request body predictable.
const BULK_DELETE_CHUNK = 5000;

/**
 * Batched form of deleteDocumentFromIndex, same best-effort semantics (a
 * 404 per item is not an error).
 *
 * The delete paths fan out over every cascade-deleted descendant, and
 * `Promise.all(rows.map(deleteDocumentFromIndex))` issued one HTTP request
 * per document with no concurrency bound at all — deleting a
 * 50,000-document matter opened 50,000 simultaneous sockets from a single
 * Node process, which is a file-descriptor exhaustion failure, not merely
 * a slow one.
 */
export async function deleteDocumentsFromIndex(documentIds: readonly string[]): Promise<void> {
  for (let i = 0; i < documentIds.length; i += BULK_DELETE_CHUNK) {
    const chunk = documentIds.slice(i, i + BULK_DELETE_CHUNK);
    // NDJSON, and the trailing newline is required — Elasticsearch rejects
    // a _bulk body whose final line isn't newline-terminated.
    const body = chunk.map((id) => JSON.stringify({ delete: { _index: INDEX_NAME, _id: id } })).join("\n") + "\n";
    const res = await fetch(`${serviceUrl()}/_bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Search index bulk delete failed: ${res.status} ${text}`);
    }
    // A 200 from _bulk does NOT mean every item succeeded — per-item
    // failures are reported inside the body. "not_found" is expected and
    // fine (never indexed, or already gone); anything else is real.
    const result = (await res.json()) as { errors?: boolean; items?: { delete?: { status: number; error?: unknown } }[] };
    if (result.errors) {
      const failed = (result.items ?? []).filter((item) => item.delete && item.delete.status !== 404 && item.delete.error);
      if (failed.length > 0) {
        throw new Error(`Search index bulk delete reported ${failed.length} failed item(s): ${JSON.stringify(failed[0].delete?.error)}`);
      }
    }
  }
}

/**
 * Removes every entry for one matter in a single request, without first
 * enumerating its document ids — the whole-matter delete knows the matter,
 * so there's no reason to round-trip once per document (or even once per
 * 5,000). org_id is filtered too, for the same defense-in-depth reason
 * searchDocuments filters both (Elasticsearch has no RLS equivalent).
 */
export async function deleteMatterFromIndex(orgId: string, matterId: string): Promise<void> {
  const res = await fetch(`${serviceUrl()}/${INDEX_NAME}/_delete_by_query?conflicts=proceed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: { bool: { filter: [{ term: { org_id: orgId } }, { term: { matter_id: matterId } }] } } }),
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`Search index matter delete failed: ${res.status} ${text}`);
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
 * query_string (not simple_query_string, which this used before boolean
 * search was added) is Elasticsearch's stricter Lucene-syntax query parser
 * — it natively understands AND/OR/NOT keywords and parenthesised grouping
 * ("(a OR b) AND NOT c") on top of everything simple_query_string already
 * supported here (+required/-excluded/"exact phrase"/* wildcard), so no
 * custom boolean-expression parser of our own is needed. The real tradeoff
 * for switching: simple_query_string never throws on malformed input (it
 * does best-effort recovery), but query_string does — a genuinely
 * malformed expression (unmatched parenthesis, a trailing operator) is a
 * real 400 from Elasticsearch. See SearchSyntaxError below for how that's
 * surfaced as a specific, catchable error rather than folded into the same
 * "search is down" 503 every other failure here produces.
 *
 * default_operator: OR (not AND) — for an eDiscovery tool, silently ANDing
 * bare words together risks under-recall (missing a responsive document),
 * a worse failure than over-recall; a reviewer typing several bare words
 * expects "any of these," narrowing explicitly with AND/+word/"phrase"
 * syntax when they want it. Unaffected by the query_string switch — this
 * setting means the same thing in both query types.
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
          must: [{ query_string: { query, fields: ["body", "filename"], default_operator: "OR" } }],
        },
      },
      track_total_hits: true,
      _source: false,
      size: maxResults,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 400 here means Elasticsearch's Lucene query parser rejected the
    // syntax itself (mismatched parens, a dangling AND/OR, etc) — a real,
    // user-actionable mistake in what they typed, not a "search is down"
    // failure. Distinguished so the route can tell the two apart and
    // respond with something the user can actually act on, instead of the
    // generic "temporarily unavailable" message every other failure here
    // gets. Not forwarding Elasticsearch's own (Lucene-internal, fairly
    // technical) error text — SearchSyntaxError's message is deliberately
    // generic, same reasoning as this app's centralized error handler
    // never leaking raw error bodies to the client.
    if (res.status === 400) {
      throw new SearchSyntaxError("Search syntax error — check your parentheses and AND/OR/NOT operators.");
    }
    throw new Error(`Search request failed: ${res.status} ${body}`);
  }

  const { hits } = (await res.json()) as { hits: { total: { value: number }; hits: { _id: string }[] } };
  return { documentIds: hits.hits.map((h) => h._id), totalHits: hits.total.value };
}

/** Thrown by searchDocuments specifically for a malformed query (see its own comment) — distinct from every other failure mode, which stays a plain Error, so callers can tell "the user's query syntax is invalid" from "search is unavailable" and respond to each differently. */
export class SearchSyntaxError extends Error {}

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
