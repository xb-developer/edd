import type { PoolClient } from "pg";

/**
 * Makes a FILTERED vector similarity search return the genuinely-nearest
 * matching rows, rather than whatever happens to survive filtering.
 *
 * The problem this solves is a recall bug, not a performance one.
 * `document_chunks_embedding_hnsw_idx` is built on the `embedding` column
 * alone — pgvector has no composite vector+scalar index — so for
 *
 *   WHERE dc.matter_id = $1 ORDER BY embedding <=> $2 LIMIT 12
 *
 * HNSW walks its graph for the rows nearest GLOBALLY, and `matter_id`
 * (plus the RLS `org_id` predicate) is applied to those candidates
 * afterwards. Migration 026's own comment claimed "the planner combines
 * them"; that is not how pgvector ANN works, and the comment has been
 * corrected. The consequence is that `/ask` can silently return FEWER than
 * RETRIEVAL_LIMIT chunks — or none — not because the matter holds nothing
 * relevant, but because the global candidate set happened not to contain
 * that matter's rows. In a legal review tool "the AI could not find the
 * document, and said so confidently" is the failure that matters.
 *
 * This is invisible while one matter holds most of document_chunks (the
 * filter then matches nearly everything). It appears as matters
 * accumulate, and it is data-dependent: depending on planner statistics
 * you get either "correct but slow" (index abandoned for an exact scan) or
 * "fast but incomplete" (ANN post-filter drops results).
 *
 * pgvector 0.8's iterative scan is the fix: when a scan comes up short
 * after filtering, it resumes the graph walk instead of stopping.
 * 'relaxed_order' (not 'strict_order') because the caller re-sorts and
 * threshold-filters the rows itself.
 *
 * Set unconditionally, with no version probe, because of two facts about
 * how Postgres handles a prefixed extension GUC — both verified against a
 * real pgvector rather than assumed:
 *
 *  - pgvector defines its GUCs when its shared library is loaded, which
 *    happens LAZILY on the session's first vector operation. So in a fresh
 *    pooled connection `current_setting('hnsw.iterative_scan', true)`
 *    returns NULL even on 0.8+ — a version probe here reports "unsupported"
 *    on a perfectly capable build, and silently disables the fix. (This is
 *    exactly what the first version of this function did, and what
 *    vectorSearch.test.ts caught.)
 *  - Setting a `prefix.name` GUC before its library loads is always
 *    allowed: Postgres keeps it as a placeholder and applies it when the
 *    library arrives. On a pgvector older than 0.8 nothing ever claims the
 *    placeholder and it is simply ignored — no error, no aborted
 *    transaction — so an older deployment keeps today's behaviour.
 *
 * SET LOCAL, so it lasts exactly as long as the caller's transaction and
 * never follows a pooled connection into the next request.
 */
export async function enableIterativeVectorScan(client: PoolClient): Promise<void> {
  await client.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
}
