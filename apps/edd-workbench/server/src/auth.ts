import type { NextFunction, Request, Response } from "express";
import { auth as jwtAuth } from "express-oauth2-jwt-bearer";
import { withOrgSession } from "@xbundle/edd-workbench-core";
import { getOrganizationMemberContext } from "./auth0Management.js";

const AUTH0_ISSUER_BASE_URL = process.env.AUTH0_ISSUER_BASE_URL;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
if (!AUTH0_ISSUER_BASE_URL || !AUTH0_AUDIENCE) {
  throw new Error("AUTH0_ISSUER_BASE_URL and AUTH0_AUDIENCE environment variables are required");
}

/**
 * Validates the JWT's signature/issuer/audience/expiry. Populates req.auth.
 *
 * dpop.enabled is explicitly off: express-oauth2-jwt-bearer defaults it to
 * true (opportunistic DPoP support) even though nothing here ever issues,
 * accepts, or verifies a DPoP proof — the only visible effect of the
 * default was every WWW-Authenticate header advertising
 * `DPoP algs="RS256 ..."` on a missing/invalid token, which reads as "DPoP
 * is required" when in fact plain Bearer tokens are accepted everywhere.
 * That's misleading, not a real security posture (see
 * COLLATE_SECURITY_FINDINGS.md Finding 3) — actually enforcing DPoP would
 * mean every caller, including the pop-out document viewer window (a
 * separate window.open() realm sharing auth state — see main.tsx),
 * proof-of-possession-signing every request, which nothing here does today.
 */
export const requireValidToken = jwtAuth({
  issuerBaseURL: AUTH0_ISSUER_BASE_URL,
  audience: AUTH0_AUDIENCE,
  dpop: { enabled: false },
});

export type Role = "admin" | "reviewer" | "litigation_support";

export interface EddRequestContext {
  userId: string;
  orgId: string;
  role: Role;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      eddContext?: EddRequestContext;
    }
  }
}

/**
 * Runs after requireValidToken. Auth0 is the sole source of truth for
 * identity and org membership — there is no local `users`/`organizations`
 * table to upsert into or look anything up in. `sub` and `org_id` are
 * trusted directly off the validated token; the caller's org-scoped role
 * (and their email/name, for display) comes from a single cached Auth0
 * Management API call (see auth0Management.ts's getOrganizationMemberContext
 * — short-TTL cache, not a live call on every request).
 *
 * No `org_id` claim means the caller didn't log in through an Auth0
 * Organization at all (this tenant's Login Experience is configured to
 * force organization discovery, so this should only happen for a stale or
 * malformed token) — 403, not a guessable fallback. There is nothing local
 * left to fall back to now that org membership isn't app-managed data.
 *
 * 403s rather than 404s on "not a member of this org" — an authorization
 * fact, not a missing-resource one.
 */
export async function resolveOrgContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth0UserId = req.auth?.payload.sub as string | undefined;
  const auth0OrgId = req.auth?.payload.org_id as string | undefined;

  if (!auth0UserId) {
    res.status(401).json({ error: "Token is missing required sub claim" });
    return;
  }
  if (!auth0OrgId) {
    res.status(403).json({ error: "Please log in through your organization" });
    return;
  }

  try {
    const context = await getOrganizationMemberContext(auth0OrgId, auth0UserId);
    if (!context) {
      res.status(403).json({ error: "You are not a member of this organization" });
      return;
    }

    req.eddContext = { userId: auth0UserId, orgId: auth0OrgId, role: context.role, email: context.email };
    next();
  } catch (err) {
    next(err);
  }
}

/** Route-level gate for admin/litigation_support-only actions (e.g. matter management, invites). */
export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.eddContext || !allowed.includes(req.eddContext.role)) {
      res.status(403).json({ error: "Insufficient role for this action" });
      return;
    }
    next();
  };
}

/**
 * Mounted once, in front of every :matterId-scoped router (documents, tags,
 * document-tags, exports, members) — see index.ts. Admins bypass the
 * matter_members table entirely (and are never a row in it); everyone else
 * needs an explicit grant. This is also what makes "a removed user's next
 * REST call is rejected" true with no extra push/kill-session mechanism —
 * every request re-checks matter_members fresh, so revocation is effective
 * the instant the row is deleted.
 */
export function requireMatterAccess() {
  return async (req: Request<{ matterId: string }>, res: Response, next: NextFunction): Promise<void> => {
    const { orgId, userId, role } = req.eddContext!;
    if (role === "admin") {
      next();
      return;
    }
    try {
      const has = await withOrgSession(orgId, (client) =>
        client.query("SELECT 1 FROM matter_members WHERE matter_id = $1 AND user_id = $2", [req.params.matterId, userId]),
      );
      if (has.rowCount === 0) {
        res.status(403).json({ error: "You do not have access to this matter" });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
