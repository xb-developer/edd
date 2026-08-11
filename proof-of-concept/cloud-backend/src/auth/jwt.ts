import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import "dotenv/config";

const domain = requireEnv("AUTH0_DOMAIN");
const audience = requireEnv("AUTH0_AUDIENCE");
const platformAdminClaim = requireEnv("AUTH0_PLATFORM_ADMIN_CLAIM");

const issuer = `https://${domain}/`;
const jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — copy .env.example to .env and fill it in`);
  return value;
}

export interface AuthClaims {
  /** Auth0 user id (the JWT's `sub`). */
  auth0UserId: string;
  /** Auth0 Organization id, present when the token was issued in an org context. */
  auth0OrgId: string | null;
  isPlatformAdmin: boolean;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthClaims;
  }
}

/**
 * Verifies the Authorization: Bearer <jwt> header against Auth0's JWKS and
 * attaches the resulting claims to req.auth. Does not resolve the caller to
 * an internal user/org row — see src/middleware/tenant.ts for that step.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  const token = header.slice("Bearer ".length);
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    req.auth = {
      auth0UserId: String(payload.sub),
      auth0OrgId: typeof payload.org_id === "string" ? payload.org_id : null,
      isPlatformAdmin: payload[platformAdminClaim] === true,
    };
    next();
  } catch (err) {
    res.status(401).json({ error: "invalid_token", detail: err instanceof Error ? err.message : String(err) });
  }
}
