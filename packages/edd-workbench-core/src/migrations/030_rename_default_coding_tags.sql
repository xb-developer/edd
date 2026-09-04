-- Renames the built-in Privilege/Review tags migration 013/014 seeded (and
-- matters.ts still seeds for every new matter, updated alongside this) —
-- "Privileged"/"Work Product" -> "Priviledged"/"Not Priviledged", and
-- "Responsive"/"Not Responsive" -> "Relevant"/"Not Relevant" ("Hot Doc" is
-- unchanged). A plain UPDATE, not a delete-and-reseed: existing
-- document_tags associations must survive a naming-convention change
-- untouched, and the tags.tags_matter_id_lower_name_idx unique index means
-- there's exactly one row per (matter_id, lower(name)) regardless of
-- whether it was originally seeded or a user happened to type the same
-- name as a custom tag — so renaming it here is the correct, unambiguous
-- action for every matter, not just ones with the "real" built-in tag.
--
-- The NOT EXISTS guard on each UPDATE skips the rare case where a matter
-- already has some OTHER tag under the new name in the same set (e.g. a
-- custom tag someone already named "Relevant" before this migration ran) —
-- renaming into that name would collide with the same unique index. That
-- matter's tag is left under its old name rather than aborting the whole
-- migration; a one-off manual fixup, not worth automating for what should
-- be a rare edge case.
UPDATE tags t SET name = 'Priviledged'
WHERE lower(t.name) = 'privileged'
  AND NOT EXISTS (SELECT 1 FROM tags o WHERE o.matter_id = t.matter_id AND lower(o.name) = 'priviledged' AND o.id <> t.id);

UPDATE tags t SET name = 'Not Priviledged'
WHERE lower(t.name) = 'work product'
  AND NOT EXISTS (SELECT 1 FROM tags o WHERE o.matter_id = t.matter_id AND lower(o.name) = 'not priviledged' AND o.id <> t.id);

UPDATE tags t SET name = 'Relevant'
WHERE lower(t.name) = 'responsive'
  AND NOT EXISTS (SELECT 1 FROM tags o WHERE o.matter_id = t.matter_id AND lower(o.name) = 'relevant' AND o.id <> t.id);

UPDATE tags t SET name = 'Not Relevant'
WHERE lower(t.name) = 'not responsive'
  AND NOT EXISTS (SELECT 1 FROM tags o WHERE o.matter_id = t.matter_id AND lower(o.name) = 'not relevant' AND o.id <> t.id);
