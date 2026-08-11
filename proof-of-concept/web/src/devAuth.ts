// Local-only substitute for useAuth0() — skips the real Auth0 login/redirect
// entirely. Mirrors just the shape App.tsx and useCloudApi.ts actually use;
// cloud-backend's matching devAuthBypass (src/auth/devBypass.ts) never
// inspects the token value, so any fixed string works here.
//
// VITE_DEV_AUTH_BYPASS is baked in at build time (import.meta.env), so this
// constant never changes for the lifetime of a given build/dev-server run -
// the conditional hook selection in auth.ts is stable across every render,
// not something that changes mid-session.
export const DEV_AUTH_BYPASS = import.meta.env.VITE_DEV_AUTH_BYPASS === "true";

export function useDevAuth() {
  return {
    isLoading: false,
    isAuthenticated: true,
    error: undefined as Error | undefined,
    user: { email: "dev@local.test (DEV_AUTH_BYPASS)" },
    loginWithRedirect: async () => {},
    logout: (_options?: unknown) => {},
    getAccessTokenSilently: async () => "dev-bypass-token",
  };
}
