// Server-only: Auth0 is the sole source of truth for who's in an
// organization — this app keeps no local mirror of org membership. The
// Management API credentials are deliberately NOT validated at module-load
// time (unlike AUTH0_ISSUER_BASE_URL/AUTH0_AUDIENCE in auth.ts) — the
// Machine-to-Machine Auth0 Application these come from may not exist yet
// when this server first deploys, and nothing else in the app depends on
// it; only the matter-access "candidates" dropdown actually calls this, so
// a missing/misconfigured credential should fail that one request, not
// crash the whole server at startup.
const AUTH0_ISSUER_BASE_URL = process.env.AUTH0_ISSUER_BASE_URL;

function issuerUrl(path: string): string {
  const base = (AUTH0_ISSUER_BASE_URL ?? "").replace(/\/+$/, "");
  return `${base}/${path}`;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

async function getManagementToken(): Promise<string> {
  const clientId = process.env.AUTH0_MGMT_CLIENT_ID;
  const clientSecret = process.env.AUTH0_MGMT_CLIENT_SECRET;
  if (!AUTH0_ISSUER_BASE_URL || !clientId || !clientSecret) {
    throw new Error(
      "AUTH0_MGMT_CLIENT_ID and AUTH0_MGMT_CLIENT_SECRET environment variables are required to call the Auth0 Management API " +
        "(create a Machine-to-Machine Auth0 Application authorized for the Management API with read:organization_members, read:users scopes)",
    );
  }

  // 60s of slack so a token doesn't expire mid-request.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const res = await fetch(issuerUrl("oauth/token"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: issuerUrl("api/v2/"),
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to obtain Auth0 Management API token: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

export interface Auth0OrgMember {
  auth0UserId: string;
  email: string;
  name: string | null;
}

interface Auth0MemberResponseRow {
  user_id: string;
  email: string;
  name?: string;
}

/**
 * GET /api/v2/organizations/{id}/members, paginated — don't assume every
 * org fits one page. Only called when the matter-access "candidates"
 * dropdown loads/refreshes, never per-request, so there's no need to cache
 * the result the way the token itself is cached.
 */
export async function listOrganizationMembers(auth0OrgId: string): Promise<Auth0OrgMember[]> {
  const token = await getManagementToken();
  const members: Auth0OrgMember[] = [];
  const perPage = 100;
  for (let page = 0; ; page++) {
    const res = await fetch(
      issuerUrl(`api/v2/organizations/${encodeURIComponent(auth0OrgId)}/members?page=${page}&per_page=${perPage}`),
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      throw new Error(`Failed to list Auth0 organization members: ${res.status} ${await res.text()}`);
    }
    const rows = (await res.json()) as Auth0MemberResponseRow[];
    for (const row of rows) {
      members.push({ auth0UserId: row.user_id, email: row.email, name: row.name ?? null });
    }
    if (rows.length < perPage) break;
  }
  return members;
}

// The three roles this app understands, in descending privilege order —
// used to pick a single role if a user somehow holds more than one within
// the same organization. Duplicated from auth.ts's Role type as a plain
// array (not importing the type here to avoid this file depending on
// auth.ts's own module-load-time env var checks) — keep in sync manually,
// there are only three.
const KNOWN_ROLES = ["admin", "litigation_support", "reviewer"] as const;
export type ManagedRole = (typeof KNOWN_ROLES)[number];

interface Auth0RoleResponseRow {
  id: string;
  name: string;
}

interface Auth0UserResponse {
  email: string;
  name?: string;
}

interface OrgMemberContext {
  role: ManagedRole;
  email: string;
  name: string | null;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// This is the one Management API lookup on the hot path — every request
// goes through resolveOrgContext, which calls getOrganizationMemberContext
// below. A live call per request would both add real latency and risk
// this tenant's Management API rate limit; a short TTL cache is the
// deliberate tradeoff (chosen over JWT custom claims or an uncached call)
// — a just-revoked user keeps access on a given API instance for up to
// this long. 60s is a starting point, not a load-bearing constant; tune
// once real traffic patterns are known.
const ORG_MEMBER_CONTEXT_TTL_MS = 60_000;
const orgMemberContextCache = new Map<string, CacheEntry<OrgMemberContext | null>>();
const userProfileCache = new Map<string, CacheEntry<{ email: string; name: string | null } | null>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return undefined;
  return entry.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * GET /api/v2/organizations/{id}/members/{user_id}/roles — the caller's
 * own org-scoped role assignment, plus their email/name for display (a
 * single Management API round trip covers both, rather than two). Returns
 * null if the user holds none of this app's three known roles in this
 * organization (including: not a member of the organization at all, which
 * Auth0 reports the same way — an empty roles list, not an error).
 */
export async function getOrganizationMemberContext(auth0OrgId: string, auth0UserId: string): Promise<OrgMemberContext | null> {
  const cacheKey = `${auth0OrgId}:${auth0UserId}`;
  const cached = getCached(orgMemberContextCache, cacheKey);
  if (cached !== undefined) return cached;

  const token = await getManagementToken();
  const [rolesRes, userRes] = await Promise.all([
    fetch(issuerUrl(`api/v2/organizations/${encodeURIComponent(auth0OrgId)}/members/${encodeURIComponent(auth0UserId)}/roles`), {
      headers: { Authorization: `Bearer ${token}` },
    }),
    fetch(issuerUrl(`api/v2/users/${encodeURIComponent(auth0UserId)}`), { headers: { Authorization: `Bearer ${token}` } }),
  ]);

  if (!rolesRes.ok) {
    throw new Error(`Failed to get Auth0 organization member roles: ${rolesRes.status} ${await rolesRes.text()}`);
  }
  if (!userRes.ok) {
    throw new Error(`Failed to get Auth0 user: ${userRes.status} ${await userRes.text()}`);
  }

  const roleRows = (await rolesRes.json()) as Auth0RoleResponseRow[];
  const assignedNames = new Set(roleRows.map((r) => r.name));
  const role = KNOWN_ROLES.find((r) => assignedNames.has(r)) ?? null;

  let result: OrgMemberContext | null = null;
  if (role) {
    const user = (await userRes.json()) as Auth0UserResponse;
    result = { role, email: user.email, name: user.name ?? null };
  }

  setCached(orgMemberContextCache, cacheKey, result, ORG_MEMBER_CONTEXT_TTL_MS);
  return result;
}

/**
 * GET /api/v2/users/{id} for email/name display only (e.g. the matter
 * access list) — no role involved, so it's cached separately and doesn't
 * need to be as fresh as the auth-gating lookup above.
 */
export async function getUserProfile(auth0UserId: string): Promise<{ email: string; name: string | null } | null> {
  const cached = getCached(userProfileCache, auth0UserId);
  if (cached !== undefined) return cached;

  const token = await getManagementToken();
  const res = await fetch(issuerUrl(`api/v2/users/${encodeURIComponent(auth0UserId)}`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) {
    setCached(userProfileCache, auth0UserId, null, ORG_MEMBER_CONTEXT_TTL_MS);
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to get Auth0 user: ${res.status} ${await res.text()}`);
  }
  const user = (await res.json()) as Auth0UserResponse;
  const result = { email: user.email, name: user.name ?? null };
  setCached(userProfileCache, auth0UserId, result, ORG_MEMBER_CONTEXT_TTL_MS);
  return result;
}
