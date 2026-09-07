import { Router, type Request } from "express";
import { searchDocuments } from "@xbundle/edd-workbench-core";

// mergeParams — mounted at /api/matters/:matterId/search (see index.ts),
// behind the same requireMatterAccess() gate as every other :matterId
// router — no new auth code needed.
export const searchRouter = Router({ mergeParams: true });

const SEARCH_UNAVAILABLE_MESSAGE = "Full-text search is temporarily unavailable. Please try again shortly.";

searchRouter.get("/", async (req: Request<{ matterId: string }>, res, next) => {
  try {
    const { orgId } = req.eddContext!;
    const { matterId } = req.params;
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (!q.trim()) {
      res.json({ documentIds: [], totalHits: 0 });
      return;
    }

    try {
      const { documentIds, totalHits } = await searchDocuments(orgId, matterId, q);
      res.json({ documentIds, totalHits });
    } catch (err) {
      // Logged here, not just swallowed into the generic user-facing
      // message below — an Elasticsearch outage (e.g. a lost/never-created
      // index, see reindexSearch.ts) needs to be diagnosable from this
      // route's own logs, not only from searchHealth.ts's separate
      // next(err) path.
      console.error(`Search failed for matter ${matterId}:`, err);
      res.status(503).json({ error: SEARCH_UNAVAILABLE_MESSAGE });
    }
  } catch (err) {
    next(err);
  }
});
