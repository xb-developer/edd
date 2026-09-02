/**
 * A document's displayed GUID is not the raw `documents.guid_number` column
 * (assigned once, permanently, at INSERT time by `nextMatterGuid` —
 * guidCounter.ts) — it's a number computed fresh from the document's
 * current position in the matter's tree, recomputed on every read. This is
 * deliberate: a container/attachment's own children are only inserted once
 * that child is pulled off its own SQS message and reprocessed, by which
 * point unrelated siblings inserted in between already hold "earlier" raw
 * numbers than a grandchild that logically belongs right after it. Flat
 * `ORDER BY guid_number` (and showing that raw value as-is) both scramble
 * the tree; this CTE fixes both by walking parent-then-children and
 * assigning the displayed number from that walk, not from insertion order.
 *
 * The raw `guid_number` column keeps its original purpose internally: it's
 * still what lets siblings inserted together (e.g. an email's attachments,
 * in mailparser's true MIME order) sort correctly relative to each other —
 * it's just no longer the value formatted and shown to the user.
 *
 * $1 must be bound to matterId by every caller — this fragment is designed
 * to be embedded in a larger query (prefixed before a final SELECT), not
 * run standalone. `numbered` is referenced, not re-executed, by every join
 * against it — Postgres materializes a recursive CTE once per statement
 * regardless of how many times it's joined.
 */
export const MATTER_DOCUMENT_TREE_CTE = `
  WITH RECURSIVE tree AS (
    SELECT d.*, ARRAY[d.guid_number] AS sort_path
    FROM documents d
    WHERE d.matter_id = $1 AND d.parent_document_id IS NULL
    UNION ALL
    SELECT c.*, tree.sort_path || c.guid_number
    FROM documents c
    JOIN tree ON c.parent_document_id = tree.id
  ),
  numbered AS (
    SELECT tree.*, ROW_NUMBER() OVER (ORDER BY tree.sort_path) AS display_guid_number
    FROM tree
  )
`;
