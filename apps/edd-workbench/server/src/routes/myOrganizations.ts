import { Router, type Request } from "express";
import { getUserOrganizationIds } from "../auth0Management.js";

// Mounted at /api/my-organizations, behind requireValidToken ONLY — see
// index.ts's own comment for why this sits ahead of the blanket
// resolveOrgContext mount rather than behind it like every other route.
export const myOrganizationsRouter = Router();

myOrganizationsRouter.get("/", async (req: Request, res, next) => {
  try {
    const auth0UserId = req.auth?.payload.sub as string | undefined;
    if (!auth0UserId) {
      res.status(401).json({ error: "Token is missing required sub claim" });
      return;
    }
    const organizationIds = await getUserOrganizationIds(auth0UserId);
    res.json({ organizationIds });
  } catch (err) {
    next(err);
  }
});
