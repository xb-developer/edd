-- Migration 030 renamed the built-in Privilege tags to "Priviledged"/"Not
-- Priviledged" — a misspelling (should be "Privileged"/"Not Privileged").
-- Same plain-UPDATE, NOT-EXISTS-guarded pattern as that migration: existing
-- document_tags associations must survive the correction untouched, and
-- the tags.tags_matter_id_lower_name_idx unique index means a matter that
-- already has some OTHER tag under the correctly-spelled name (a custom
-- tag someone typed before this ran) is left alone rather than colliding —
-- a rare one-off manual fixup, not worth automating.
UPDATE tags t SET name = 'Privileged'
WHERE t.name = 'Priviledged'
  AND NOT EXISTS (SELECT 1 FROM tags o WHERE o.matter_id = t.matter_id AND lower(o.name) = 'privileged' AND o.id <> t.id);

UPDATE tags t SET name = 'Not Privileged'
WHERE t.name = 'Not Priviledged'
  AND NOT EXISTS (SELECT 1 FROM tags o WHERE o.matter_id = t.matter_id AND lower(o.name) = 'not privileged' AND o.id <> t.id);
