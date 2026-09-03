import { Router } from "express";
import { withOrgSession, getIndexHealth } from "@xbundle/edd-workbench-core";

// Mounted at /api/search-health — cross-org infra visibility would be nice,
// but a real Postgres-wide count needs an RLS bypass no live app-role
// route should have; scoped to the calling user's own org instead, which
// is also the more useful question ("is MY org's data fully indexed?").
// No new alerting infrastructure here (this app has none today for
// comparable risks like DLQ depth or GPU capacity failures) — just
// visibility any org member can check, with reindexSearch.ts as the actual
// fix once a real mismatch is noticed (e.g. after an Elasticsearch instance
// replacement wiped its local, non-snapshotted data).
export const searchHealthRouter = Router();

searchHealthRouter.get("/", async (req, res, next) => {
  try {
    const { orgId } = req.eddContext!;

    const [{ docCount: esDocCount }, postgresRows] = await Promise.all([
      getIndexHealth(orgId),
      withOrgSession(orgId, (client) =>
        client.query<{ count: string }>("SELECT COUNT(*) FROM documents WHERE ingest_status IN ('ready', 'failed')"),
      ),
    ]);

    res.json({ esDocCount, postgresDocCount: Number(postgresRows.rows[0].count) });
  } catch (err) {
    next(err);
  }
});
