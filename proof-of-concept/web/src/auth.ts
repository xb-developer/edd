import { useAuth0 } from "@auth0/auth0-react";
import { DEV_AUTH_BYPASS, useDevAuth } from "./devAuth";

/**
 * DEV_AUTH_BYPASS is a build-time constant (see devAuth.ts) - this branch is
 * the same on every render for the life of the app, so it doesn't run afoul
 * of the rules-of-hooks concern about hooks changing across renders.
 */
export function useAppAuth() {
  if (DEV_AUTH_BYPASS) return useDevAuth();
  return useAuth0();
}
