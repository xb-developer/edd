import { StrictMode } from "react";
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
import "@xbundle/edd-workbench-ui/src/styles.css";

// Set once at module load, not per-render — this never changes for the
// life of the page, and both AppShell and ViewerWindowShell below need it.
const viewerWindowParams = parseViewerWindowParams(window.location.search);

// Plain login, no `organization` param — the tenant's Login Experience is
// configured to prompt for the organization itself (see
// server/src/auth.ts's resolveOrgContext), so the resulting token's
// trusted org_id claim is all the server needs. Nothing here needs to
// know about orgs at all; a user simply signs in with whatever Auth0
// account has been added to the organization and assigned a role there
// directly (Auth0 Organizations is the sole source of truth for identity
// and org membership — there's no local invite system).
function AppShell() {
  const { isAuthenticated, isLoading, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0();

  if (isLoading) {
    return (
      <div className="matter-screen">
        <p className="empty-note">Loading…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="matter-screen">
        <div className="matter-card" style={{ textAlign: "center" }}>
          <div className="brand" style={{ justifyContent: "center", marginBottom: 18 }}>
            <span className="mark" style={{ borderColor: "var(--navy)", color: "var(--navy)" }}>
              eD
            </span>
            <h1>EDD Workbench</h1>
          </div>
          <button type="button" onClick={() => loginWithRedirect()} style={{ width: "100%", padding: "9px 0" }}>
            Log in
          </button>
        </div>
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
      <div className="matter-screen">
        <p className="empty-note">Loading…</p>
      </div>
    );
  }
  if (!isAuthenticated) {
    return (
      <div className="matter-screen">
        <p className="preview-unsupported">Session expired — close this window and reopen the viewer from the main application.</p>
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
      // only way to make the pop-out window work at all.
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
