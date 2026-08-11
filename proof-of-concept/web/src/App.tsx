import { useAppAuth } from "./auth";
import { Workspace } from "./Workspace";

export function App() {
  const { isLoading, isAuthenticated, loginWithRedirect, logout, user, error } = useAppAuth();

  if (isLoading) {
    return (
      <div className="centered-screen">
        <p>Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="centered-screen">
        <h1>EDD Workbench</h1>
        <p className="error-text">Sign-in failed: {error.message}</p>
        <button onClick={() => loginWithRedirect()}>Try again</button>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="centered-screen">
        <h1>EDD Workbench</h1>
        <p>Sign in with your firm account to continue.</p>
        <button onClick={() => loginWithRedirect()}>Log in</button>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <span className="brand">EDD Workbench</span>
        <span className="user-info">
          {user?.email}
          <button className="link-button" onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}>
            Log out
          </button>
        </span>
      </header>
      <Workspace />
    </div>
  );
}
