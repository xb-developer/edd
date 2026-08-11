import { createHmac, timingSafeEqual } from "node:crypto";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — copy .env.example to .env and fill it in`);
  return value;
}

const secret = () => requireEnv("LOCAL_STORE_SIGNING_SECRET");

/** Signs `key` + an expiry so the local-dev download route can verify it without a database round-trip. */
export function signLocalDownload(key: string, expiresInSeconds: number): { token: string; expires: number } {
  const expires = Date.now() + expiresInSeconds * 1000;
  const token = createHmac("sha256", secret()).update(`${key}:${expires}`).digest("hex");
  return { token, expires };
}

export function verifyLocalDownload(key: string, expires: number, token: string): boolean {
  if (Date.now() > expires) return false;
  const expected = createHmac("sha256", secret()).update(`${key}:${expires}`).digest("hex");
  const a = Buffer.from(token, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
