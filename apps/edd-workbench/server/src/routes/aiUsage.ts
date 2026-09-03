import { Router } from "express";
import { getAiUsageForUser } from "@xbundle/edd-workbench-core";

// Mounted at /api/ai-usage — org-scoped but not matter-scoped (ai_usage has
// no matter_id), same shape as audit.ts. Every caller can only ever see
// their OWN usage; there's deliberately no cross-user listing endpoint
// here, since that would need an admin gate this route doesn't have.
export const aiUsageRouter = Router();

aiUsageRouter.get("/me", async (req, res, next) => {
  try {
    const { orgId, userId } = req.eddContext!;
    const usage = await getAiUsageForUser(orgId, userId);
    res.json(usage);
  } catch (err) {
    next(err);
  }
});
