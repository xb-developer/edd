-- documents' RLS policy (migration 009) has no FOR clause, so it already
-- applies to DELETE — only the role grant was missing, matching how
-- matters/org_memberships already grant DELETE but documents never needed
-- to until this table's own delete-a-document feature.
GRANT DELETE ON documents TO edd_workbench_app;
