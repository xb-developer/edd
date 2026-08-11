import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — copy .env.example to .env and fill it in`);
  return value;
}

const domain = requireEnv("AUTH0_DOMAIN");
const mgmtClientId = requireEnv("AUTH0_MGMT_CLIENT_ID");
const mgmtClientSecret = requireEnv("AUTH0_MGMT_CLIENT_SECRET");
const mgmtAudience = `https://${domain}/api/v2/`;

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Client-credentials grant for the Auth0 Management API, cached until near expiry. */
async function getManagementToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }
  const res = await fetch(`https://${domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: mgmtClientId,
      client_secret: mgmtClientSecret,
      audience: mgmtAudience,
    }),
  });
  if (!res.ok) {
    throw new Error(`Auth0 Management token request failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

async function mgmtFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getManagementToken();
  const res = await fetch(`https://${domain}/api/v2${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Auth0 Management API ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

export interface CreatedOrganization {
  auth0OrgId: string;
}

/** Creates an Auth0 Organization for a newly onboarded law firm. */
export async function createOrganization(name: string, displayName: string): Promise<CreatedOrganization> {
  const res = await mgmtFetch("/organizations", {
    method: "POST",
    body: JSON.stringify({ name, display_name: displayName }),
  });
  const body = (await res.json()) as { id: string };
  return { auth0OrgId: body.id };
}

export interface CreatedUser {
  auth0UserId: string;
}

/**
 * Creates an Auth0 user via email/password connection and adds them to the
 * given Organization. The user is created with `email_verified: false` and
 * Auth0's "change password" flow is expected to be triggered separately
 * (see docs/auth0-setup.md) rather than emailing a plaintext password.
 */
export async function createUserInOrganization(
  auth0OrgId: string,
  email: string,
  connection = "Username-Password-Authentication",
): Promise<CreatedUser> {
  const createRes = await mgmtFetch("/users", {
    method: "POST",
    body: JSON.stringify({
      email,
      connection,
      password: cryptoRandomPassword(),
      email_verified: false,
      verify_email: false,
    }),
  });
  const user = (await createRes.json()) as { user_id: string };

  await mgmtFetch(`/organizations/${auth0OrgId}/members`, {
    method: "POST",
    body: JSON.stringify({ members: [user.user_id] }),
  });

  return { auth0UserId: user.user_id };
}

/** Triggers Auth0's password-reset email so the new user sets their own password. */
export async function sendPasswordResetEmail(email: string, connection = "Username-Password-Authentication") {
  const res = await fetch(`https://${domain}/dbconnections/change_password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: mgmtClientId, email, connection }),
  });
  if (!res.ok) {
    throw new Error(`Auth0 password-reset request failed: ${res.status} ${await res.text()}`);
  }
}

function cryptoRandomPassword(): string {
  // Temporary password immediately overwritten by the user via the reset-email
  // flow — never surfaced to anyone, so a random high-entropy string is enough.
  return `Tmp-${crypto.randomUUID()}-${crypto.randomUUID()}`;
}
