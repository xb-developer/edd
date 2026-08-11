import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Auth0Provider } from "@auth0/auth0-react";
import { App } from "./App";
import { DEV_AUTH_BYPASS } from "./devAuth";
import "./styles.css";

// In bypass mode, App/useCloudApi never call into real Auth0 (see auth.ts) -
// skipping the provider too means no Auth0 network calls happen at all
// locally, not just that login is skipped.
const app = DEV_AUTH_BYPASS ? (
  <App />
) : (
  <Auth0Provider
    domain={import.meta.env.VITE_AUTH0_DOMAIN}
    clientId={import.meta.env.VITE_AUTH0_CLIENT_ID}
    authorizationParams={{
      redirect_uri: window.location.origin,
      audience: import.meta.env.VITE_AUTH0_AUDIENCE,
    }}
    cacheLocation="localstorage"
    useRefreshTokens
  >
    <App />
  </Auth0Provider>
);

createRoot(document.getElementById("root")!).render(<StrictMode>{app}</StrictMode>);
