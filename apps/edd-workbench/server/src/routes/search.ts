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
    } catch {
      res.status(503).json({ error: SEARCH_UNAVAILABLE_MESSAGE });
    }
  } catch (err) {
    next(err);
  }
});
