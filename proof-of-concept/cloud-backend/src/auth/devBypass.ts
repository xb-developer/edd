import type { NextFunction, Request, Response } from "express";
import { withTenantContext } from "../db/pool.js";

// Never a real Auth0 identity — a genuine Auth0 `sub` is always
// `<connection>|<id>` from a real connection (auth0|, google-oauth2|, ...),
// so this literal string can never collide with one.
const DEV_AUTH0_USER_ID = "local-dev|bypass-user";
const DEV_ORG_NAME = "Local Dev Firm";
const DEV_USER_EMAIL = "dev@local.test";
const DEV_MATTER_NAME = "Local Dev Matter";

/**
 * Double-gated on purpose (Section 4's mock-checkout route sets the
 * precedent) — this disables authentication entirely, so one flag being
 * left on by accident must not be enough to do that in a real deployment.
 * Both have to be true: NODE_ENV isn't production, AND this was explicitly
 * opted into (not just implied by NODE_ENV=development).
 */
export function isDevAuthBypassEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_BYPASS === "true";
}

// A singleton in-flight promise, not a boolean — the SPA fires several
// requests in parallel on load (matters, groups, ...), each hitting this
// middleware concurrently. A boolean flag flipped only after everything
// finished let concurrent callers race: two requests could both see
// "not seeded yet", both try to create the org/user, and only one wins the
// unique constraint on users.auth0_user_id - the loser's whole transaction
// rolls back, but the winner had already committed org+user+group in a
// SEPARATE transaction from the matter insert, so a crash or a slow client
// disconnect between those two could still leave a half-seeded org with no
// matter. Caching the promise itself means every concurrent caller awaits
// the exact same attempt, so the provisioning logic only ever runs once per
// process — this is what actually closes the race, not the DB check alone.
let seedingPromise: Promise<void> | null = null;

function ensureSeeded(): Promise<void> {
  if (!seedingPromise) {
    seedingPromise = seedOnce().catch((err) => {
      // Don't cache a permanent failure - let the next request try again
      // instead of every future request being stuck behind one bad attempt.
      seedingPromise = null;
      throw err;
    });
  }
  return seedingPromise;
}

/**
 * Creates a real organization/user/group/matter for the fixed dev identity
 * the first time it's needed, so resolveTenant's normal (unmodified) lookup
 * finds a genuine row — every layer below the JWT check (RLS, tenant
 * resolution, matters) behaves exactly as it does for a real login.
 *
 * The org/user/group inserts run under a platform-admin context (those
 * tables' INSERT policies all have that bypass) — the matter insert
 * deliberately doesn't, and runs under the just-created user's own tenant
 * context instead, the same split provisionLead() uses and for the same
 * reason (matters_insert has no platform-admin bypass by design).
 */
async function seedOnce(): Promise<void> {
  const alreadyExists = await withTenantContext(
    { organizationId: null, userId: null, isPlatformAdmin: true },
    async (client) => {
      const { rows } = await client.query("SELECT id FROM users WHERE auth0_user_id = $1", [DEV_AUTH0_USER_ID]);
      return rows.length > 0;
    },
  );
  if (alreadyExists) return;

  const { organizationId, userId, groupId } = await withTenantContext(
    { organizationId: null, userId: null, isPlatformAdmin: true },
    async (client) => {
      const org = await client.query(
        "INSERT INTO organizations (auth0_org_id, name) VALUES ($1, $2) RETURNING id",
        [`local-dev|org-${Date.now()}`, DEV_ORG_NAME],
      );
      const organizationId = org.rows[0].id as string;

      const user = await client.query(
        "INSERT INTO users (auth0_user_id, organization_id, email, is_org_admin) VALUES ($1, $2, $3, true) RETURNING id",
        [DEV_AUTH0_USER_ID, organizationId, DEV_USER_EMAIL],
      );
      const userId = user.rows[0].id as string;

      const group = await client.query(
        "INSERT INTO groups (organization_id, name) VALUES ($1, $2) RETURNING id",
        [organizationId, "Local Dev Team"],
      );
      const groupId = group.rows[0].id as string;

      await client.query("INSERT INTO group_members (group_id, user_id, organization_id) VALUES ($1, $2, $3)", [
        groupId,
        userId,
        organizationId,
      ]);

      return { organizationId, userId, groupId };
    },
  );

  await withTenantContext({ organizationId, userId, isPlatformAdmin: false }, async (client) => {
    await client.query(
      "INSERT INTO matters (organization_id, group_id, created_by_user_id, name) VALUES ($1, $2, $3, $4)",
      [organizationId, groupId, userId, DEV_MATTER_NAME],
    );
  });
}

/** Local-only substitute for requireAuth — see isDevAuthBypassEnabled(). */
export async function devAuthBypass(req: Request, _res: Response, next: NextFunction) {
  await ensureSeeded();
  req.auth = { auth0UserId: DEV_AUTH0_USER_ID, auth0OrgId: null, isPlatformAdmin: false };
  next();
}
