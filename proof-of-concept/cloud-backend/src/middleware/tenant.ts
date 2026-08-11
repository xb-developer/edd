import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import { withTenantContext, type TenantContext } from "../db/pool.js";
import { logAudit, logAuditForRequest } from "../audit/log.js";

export interface ResolvedTenant extends TenantContext {
  isOrgAdmin: boolean;
}

declare module "express-serve-static-core" {
  interface Request {
    tenant?: ResolvedTenant;
    /** Runs `fn` with RLS session variables set from req.tenant. */
    withTenant?: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  }
}

/**
 * Resolves the verified Auth0 identity on req.auth (set by requireAuth) to
 * an internal user/organization row, and attaches req.tenant + req.withTenant.
 * Must run after requireAuth. Platform admins have no internal user row —
 * they operate above tenant scope by design (Section 4.2 of the deployment plan).
 */
export async function resolveTenant(req: Request, res: Response, next: NextFunction) {
  if (!req.auth) {
    res.status(401).json({ error: "missing_token" });
    return;
  }

  if (req.auth.isPlatformAdmin) {
    req.tenant = { organizationId: null, userId: null, isPlatformAdmin: true, isOrgAdmin: false };
    req.withTenant = (fn) => withTenantContext(req.tenant!, fn);
    next();
    return;
  }

  try {
    // Narrow, self-only lookup: the WHERE clause is bound to the caller's own
    // verified auth0 sub, so using the platform-admin RLS bypass here can't
    // surface anyone else's row — it only exists to escape the chicken-and-egg
    // problem of not yet knowing the org id RLS would otherwise require.
    const row = await withTenantContext(
      { organizationId: null, userId: null, isPlatformAdmin: true },
      async (client) => {
        const { rows } = await client.query(
          "SELECT id, organization_id, is_org_admin FROM users WHERE auth0_user_id = $1",
          [req.auth!.auth0UserId],
        );
        return rows[0] as { id: string; organization_id: string; is_org_admin: boolean } | undefined;
      },
    );

    if (!row) {
      // No req.tenant exists yet at this point, so there's no organization
      // to attribute the row to - written under a platform-admin context
      // (satisfies audit_insert's WITH CHECK) with the raw Auth0 subject
      // recorded in detail so the event is still traceable.
      logAudit(
        { organizationId: null, userId: null, isPlatformAdmin: true },
        { organizationId: null, userId: null, action: "auth.no_matching_account", allowed: false, detail: { auth0UserId: req.auth!.auth0UserId } },
      );
      res.status(403).json({ error: "no_matching_account" });
      return;
    }

    req.tenant = {
      organizationId: row.organization_id,
      userId: row.id,
      isPlatformAdmin: false,
      isOrgAdmin: row.is_org_admin,
    };
    req.withTenant = (fn) => withTenantContext(req.tenant!, fn);
    next();
  } catch (err) {
    console.error("tenant resolution failed:", err);
    res.status(500).json({ error: "tenant_resolution_failed", detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Identifies the endpoint a denied request was aimed at, for the audit trail. */
function routeAction(req: Request): string {
  return `${req.method} ${req.baseUrl}${req.path}`;
}

/** Route guard: 403s unless the resolved caller is the platform admin. */
export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.tenant?.isPlatformAdmin) {
    logAuditForRequest(req, { action: routeAction(req), allowed: false, detail: { reason: "platform_admin_required" } });
    res.status(403).json({ error: "platform_admin_required" });
    return;
  }
  next();
}

/** Route guard: 403s unless the resolved caller is an org admin (or platform admin). */
export function requireOrgAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.tenant?.isPlatformAdmin && !req.tenant?.isOrgAdmin) {
    logAuditForRequest(req, { action: routeAction(req), allowed: false, detail: { reason: "org_admin_required" } });
    res.status(403).json({ error: "org_admin_required" });
    return;
  }
  next();
}
