import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { EddWorkbenchWorkspace, DocumentViewerWindow, parseViewerWindowParams } from "@xbundle/edd-workbench-ui";
// Self-hosted, not the Google Fonts CDN the POC uses — this is a multi-tenant
// SaaS app, and adding a new always-on third-party CDN dependency to every
// page load is a worse default than serving two static font packages from
// the app's own build, for negligible extra effort. 400 (body text) and 600
// (headings/brand/buttons/guid badges — used throughout styles.css) cover
// every weight the design actually uses.
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
// theme.css first, deliberately: it carries `@import "tailwindcss"`, and
// Tailwind's preflight must be layered BEFORE the app's own resets so
// styles.css's `*`/`body`/`button` rules still win where they disagree.
import "@xbundle/edd-workbench-ui/src/theme.css";
import "@xbundle/edd-workbench-ui/src/styles.css";

// Set once at module load, not per-render — this never changes for the
// life of the page, and both AppShell and ViewerWindowShell below need it.
const viewerWindowParams = parseViewerWindowParams(window.location.search);

// Plain login, no `organization` param — a user can belong to more than one
// Auth0 Organization (tenant), and Auth0's own Login Experience has no way
// to ask "which one" without either the user typing an org name/id from
// memory or DNS-verified email-domain discovery (rejected as unworkable for
// a multi-tenant product with no control over customers' DNS). So instead:
// log in once with no org, then (below) look up which Organization(s) this
// identity belongs to via the server, and complete a SECOND loginWithRedirect
// scoped to the resolved org. This second round trip is unavoidable, not a
// workaround — Auth0 has confirmed getAccessTokenSilently cannot silently
// swap in an org-scoped token; only a real redirect (or popup) with an
// explicit `organization` param can. The app is designed around one org per
// user, so zero or multiple orgs are treated as error states below rather
// than a picker UI.
type OrgResolutionState = { status: "checking" } | { status: "redirecting" } | { status: "error"; reason: "none" | "multiple" | "failed" };

function AppShell() {
  const { isAuthenticated, isLoading, loginWithRedirect, logout, getAccessTokenSilently, user } = useAuth0();
  const [orgResolution, setOrgResolution] = useState<OrgResolutionState | null>(null);
  // StrictMode double-invokes effects in dev, and this effect's own work
  // (a Management API call, then a real navigation) must only ever run
  // once per login — this ref, not effect deps, is what prevents that.
  const orgResolutionStarted = useRef(false);

  // Only a login routed through an Organization carries this claim on the
  // ID token (see the comment above) — its absence is exactly "just did the
  // plain first-stage login, still needs resolving", including on every
  // render until the redirect below actually navigates away.
  const needsOrgResolution = isAuthenticated && !user?.org_id;

  useEffect(() => {
    if (!needsOrgResolution || orgResolutionStarted.current) return;
    orgResolutionStarted.current = true;
    setOrgResolution({ status: "checking" });

    (async () => {
      try {
        const token = await getAccessTokenSilently({ authorizationParams: { audience: import.meta.env.VITE_AUTH0_AUDIENCE } });
        const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/my-organizations`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          throw new Error(`Failed to resolve organization: ${res.status}`);
        }
        const body = (await res.json()) as { organizationIds: string[] };
        if (body.organizationIds.length === 0) {
          setOrgResolution({ status: "error", reason: "none" });
          return;
        }
        if (body.organizationIds.length > 1) {
          setOrgResolution({ status: "error", reason: "multiple" });
          return;
        }
        setOrgResolution({ status: "redirecting" });
        await loginWithRedirect({ authorizationParams: { organization: body.organizationIds[0] } });
      } catch (err) {
        console.error(err);
        setOrgResolution({ status: "error", reason: "failed" });
      }
    })();
  }, [needsOrgResolution, getAccessTokenSilently, loginWithRedirect]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-paper">
        <p className="px-0.5 py-1 text-[11.5px] italic text-ink-soft">Loading…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex h-screen items-center justify-center bg-paper">
        <div className="w-[420px] max-w-[90vw] rounded-lg border border-line bg-panel px-[26px] py-7 text-center shadow-[0_4px_24px_rgba(27,33,48,0.08)]">
          <div className="mb-[18px] flex items-baseline justify-center gap-2">
            <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[3px] border-[1.5px] border-navy font-mono text-[11px] font-semibold text-navy">
              Co
            </span>
            <h1 className="m-0 text-base font-semibold">Collate</h1>
          </div>
          <button type="button" onClick={() => loginWithRedirect()} style={{ width: "100%", padding: "9px 0" }}>
            Log in
          </button>
        </div>
      </div>
    );
  }

  if (needsOrgResolution) {
    if (orgResolution?.status === "error") {
      const message =
        orgResolution.reason === "none"
          ? "Your account isn't assigned to an organization yet. Contact your administrator to be added."
          : orgResolution.reason === "multiple"
            ? "Your account belongs to more than one organization, which isn't supported yet. Contact your administrator."
            : "Something went wrong while signing you in. Please try again.";
      return (
        <div className="flex h-screen items-center justify-center bg-paper">
          <div className="w-[420px] max-w-[90vw] rounded-lg border border-line bg-panel px-[26px] py-7 text-center shadow-[0_4px_24px_rgba(27,33,48,0.08)]">
            <div className="mb-[18px] flex items-baseline justify-center gap-2">
              <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[3px] border-[1.5px] border-navy font-mono text-[11px] font-semibold text-navy">
                Co
              </span>
              <h1 className="m-0 text-base font-semibold">Collate</h1>
            </div>
            <p className="px-0.5 py-1 text-[11.5px] italic text-ink-soft mb-[18px]">
              {message}
            </p>
            <button
              type="button"
              onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
              style={{ width: "100%", padding: "9px 0" }}
            >
              Log out
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-screen items-center justify-center bg-paper">
        <p className="px-0.5 py-1 text-[11.5px] italic text-ink-soft">Signing you in…</p>
      </div>
    );
  }

  return (
    <EddWorkbenchWorkspace
      apiBaseUrl={import.meta.env.VITE_API_BASE_URL}
      getAccessToken={() => getAccessTokenSilently({ authorizationParams: { audience: import.meta.env.VITE_AUTH0_AUDIENCE } })}
      // Forces a genuinely fresh login next time, rather than a silently-renewed
      // token that can still carry claims from before an Auth0 Action change —
      // logoutParams.returnTo must match an Allowed Logout URL on the
      // application (already set to this same origin earlier).
      onLogout={() => logout({ logoutParams: { returnTo: window.location.origin } })}
    />
  );
}

// The pop-out viewer window's own root — same bundle, same Auth0Provider
// config (below), branched purely on the `?viewerMatterId=...` query string
// set by MatterDetail's "Pop out" button (see viewer-window/viewerWindowUrl.ts).
// Deliberately has no loginWithRedirect fallback: the shared Auth0Provider's
// `redirect_uri` is hardcoded to the bare origin, so a redirect from here
// would silently strand the user at a full copy of the main app, losing the
// viewer params — the cacheLocation:"localStorage" setting below is what's
// meant to make that path unnecessary (a same-origin window picks up the
// already-cached token with no redirect), and if that token is genuinely
// missing/expired, the fix is "close this window and reopen the viewer,"
// not a retry loop.
function ViewerWindowShell({ matterId, documentId, sessionId }: { matterId: string; documentId: string | null; sessionId: string }) {
  const { isAuthenticated, isLoading, getAccessTokenSilently } = useAuth0();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-paper">
        <p className="px-0.5 py-1 text-[11.5px] italic text-ink-soft">Loading…</p>
      </div>
    );
  }
  if (!isAuthenticated) {
    return (
      <div className="flex h-screen items-center justify-center bg-paper">
        <p className="rounded border border-dashed border-line p-6 text-center text-xs text-ink-soft">Session expired — close this window and reopen the viewer from the main application.</p>
      </div>
    );
  }

  return (
    <DocumentViewerWindow
      apiBaseUrl={import.meta.env.VITE_API_BASE_URL}
      getAccessToken={() => getAccessTokenSilently({ authorizationParams: { audience: import.meta.env.VITE_AUTH0_AUDIENCE } })}
      matterId={matterId}
      initialDocumentId={documentId}
      sessionId={sessionId}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Auth0Provider
      domain={import.meta.env.VITE_AUTH0_DOMAIN}
      clientId={import.meta.env.VITE_AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: import.meta.env.VITE_AUTH0_AUDIENCE,
      }}
      // localStorage, not the default in-memory cache — required so the
      // pop-out viewer window (a separate window.open() realm with its
      // own Auth0Client instance) can find the already-cached token on
      // mount instead of needing its own login/redirect round-trip. Same-
      // origin windows share localStorage synchronously. This is a real,
      // deliberate security-posture change (tokens become readable by any
      // script running on this origin, not held only in one tab's JS
      // heap) — accepted because a compromised page could already call
      // every authenticated API directly regardless of where the token
      // sits, so the actual exposure difference is small, and it's the
      // only way to make the pop-out window work at all. Re-reviewed
      // against COLLATE_SECURITY_FINDINGS.md Finding 3 (2026-09-04) and
      // reaffirmed as-is for the same reason — the DPoP-advertisement half
      // of that finding was a real bug (fixed in server/src/auth.ts) and
      // is unrelated to this decision.
      cacheLocation="localstorage"
    >
      {viewerWindowParams ? (
        <ViewerWindowShell matterId={viewerWindowParams.matterId} documentId={viewerWindowParams.documentId} sessionId={viewerWindowParams.sessionId} />
      ) : (
        <AppShell />
      )}
    </Auth0Provider>
  </StrictMode>,
);
