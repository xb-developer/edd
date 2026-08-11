import type { NextFunction, Request, Response } from "express";
import { auth as jwtAuth } from "express-oauth2-jwt-bearer";
import { withUserIdentitySession } from "@xbundle/edd-workbench-core";

const AUTH0_ISSUER_BASE_URL = process.env.AUTH0_ISSUER_BASE_URL;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
if (!AUTH0_ISSUER_BASE_URL || !AUTH0_AUDIENCE) {
  throw new Error("AUTH0_ISSUER_BASE_URL and AUTH0_AUDIENCE environment variables are required");
}

/** Validates the JWT's signature/issuer/audience/expiry. Populates req.auth. */
export const requireValidToken = jwtAuth({
  issuerBaseURL: AUTH0_ISSUER_BASE_URL,
  audience: AUTH0_AUDIENCE,
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
 * Runs after requireValidToken. Auth0 Organizations turned out to be
 * unavailable on this tenant's plan, so — unlike the original design — there
 * is no trusted org_id claim to read the caller's org from. Instead: upsert
 * their `users` row from the token's own identity claims (sub/email — safe
 * to trust, Auth0 already verified them), then look up which org(s) that
 * identity belongs to directly. A user with more than one membership gets
 * their earliest one — there's no multi-org picker yet (a real gap, not a
 * deliberate design choice; flagged as a fast-follow, not silently ignored).
 * 403s rather than 404s on "not a member of any org" — an authorization
 * fact, not a missing-resource one.
 */
export async function resolveOrgContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth0UserId = req.auth?.payload.sub as string | undefined;
  const email = req.auth?.payload.email as string | undefined;

  if (!auth0UserId) {
    res.status(401).json({ error: "Token is missing required sub claim" });
    return;
  }

  try {
    const context = await withUserIdentitySession({ auth0UserId, email: email ?? "" }, async (client, userId) => {
      const membershipRow = await client.query<{ org_id: string; role: Role }>(
        "SELECT org_id, role FROM org_memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1",
        [userId],
      );
      if (membershipRow.rowCount! > 0) {
        return { userId, orgId: membershipRow.rows[0].org_id, role: membershipRow.rows[0].role, email: email ?? "" };
      }

      // No membership yet — but this may be someone's very first login
      // after being invited (see routes/orgInvites.ts): the invitation was
      // necessarily created before their users row could possibly exist, so
      // this is where it actually takes effect, matched on email. Only ever
      // consumes a 'pending' row, so re-logging-in after acceptance (or a
      // revoked/already-used invite) can't re-grant membership.
      if (!email) return null;
      const invitationRow = await client.query<{ id: string; org_id: string; role: Role }>(
        "SELECT id, org_id, role FROM org_invitations WHERE email = $1 AND status = 'pending' LIMIT 1",
        [email],
      );
      if (invitationRow.rowCount === 0) return null;

      const { id: invitationId, org_id: orgId, role } = invitationRow.rows[0];
      await client.query("INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, $3)", [orgId, userId, role]);
      await client.query("UPDATE org_invitations SET status = 'accepted', accepted_at = now() WHERE id = $1", [invitationId]);

      return { userId, orgId, role, email };
    });

    if (!context) {
      res.status(403).json({ error: "You are not a member of any organization yet" });
      return;
    }

    req.eddContext = context;
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
