import { useMemo } from "react";
import { useAppAuth } from "./auth";
import { api } from "./api";

export type BoundApi = {
  [K in keyof typeof api]: typeof api[K] extends (token: string, ...args: infer A) => infer R
    ? (...args: A) => R
    : never;
};

/**
 * Binds every api.ts function to a freshly-acquired Auth0 access token —
 * getAccessTokenSilently handles refresh transparently, so call sites never
 * think about token lifetime, just call e.g. `api.listMatters()` directly.
 */
export function useBoundApi(): BoundApi {
  const { getAccessTokenSilently } = useAppAuth();

  return useMemo(() => {
    const bound = {} as BoundApi;
    for (const key of Object.keys(api) as Array<keyof typeof api>) {
      // @ts-expect-error — building a homogeneous bound-function map generically
      bound[key] = async (...args: unknown[]) => {
        const token = await getAccessTokenSilently();
        // @ts-expect-error — same reason
        return api[key](token, ...args);
      };
    }
    return bound;
  }, [getAccessTokenSilently]);
}
