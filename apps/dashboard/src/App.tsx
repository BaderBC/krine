import { useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { api, ApiError, errorMessage, mutation } from "./api";
import { Loading, Notice, Time } from "./shared";
import { InstallationContext } from "./Overview";
import { useAccess } from "./access";
import { SignIn, CredentialReveal } from "./OperatorAuth";
import { hasLegacyRecovery } from "./operator";
import type { AuthMethods } from "./operator";

export function App() {
  const { session, suspended, epoch, can, revealedCredential } = useAccess();
  const [initialized, setInitialized] = useState(false);
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [legacy] = useState(() => {
    try {
      return hasLegacyRecovery(sessionStorage);
    } catch {
      return false;
    }
  });
  const dialog = useRef<HTMLDialogElement>(null);
  const signoutDialog = useRef<HTMLDialogElement>(null);
  const [confirmSignout, setConfirmSignout] = useState(false);
  useEffect(() => {
    if (confirmSignout) signoutDialog.current?.showModal();
    else if (signoutDialog.current?.open) signoutDialog.current.close();
  }, [confirmSignout]);
  const channel = useRef<BroadcastChannel | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  async function reloadMethods() {
    try {
      setMethods(await api.authMethods());
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  useEffect(() => {
    let live = true;
    async function initialize() {
      try {
        const value = await api.authMethods();
        if (!live) return;
        setMethods(value);
        await api.session();
      } catch (cause) {
        if (live && !(cause instanceof ApiError && cause.status === 401))
          setError(errorMessage(cause));
      } finally {
        if (live) setInitialized(true);
      }
    }
    async function refresh() {
      if (!api.current) return;
      try {
        const value = await api.authMethods();
        if (live) setMethods(value);
        await api.session();
      } catch (cause) {
        if (live && cause instanceof ApiError && cause.status === 401)
          api.suspend();
      }
    }
    api.onPrivilegeChanged = () => void refresh();
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("krine-operator-session");
      channel.current.onmessage = () => {
        api.invalidateRequests();
        api.suspend();
        void refresh();
      };
    }
    const focus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    const interval = setInterval(() => void refresh(), 60_000);
    void initialize();
    return () => {
      live = false;
      api.onPrivilegeChanged = undefined;
      clearInterval(interval);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      channel.current?.close();
      channel.current = null;
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    const delay = Math.max(
      0,
      Math.min(session.expires_at - Date.now(), 2_147_483_647),
    );
    const timer = setTimeout(() => api.suspend(), delay);
    return () => clearTimeout(timer);
  }, [session]);
  useEffect(() => {
    if (suspended && session) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [suspended, session]);
  const section =
    location.pathname === "/inspect/check"
      ? "checks"
      : location.pathname.startsWith("/inspect/") ||
          location.pathname.startsWith("/entities/")
        ? "activity"
        : location.pathname.split("/")[1] || "overview";
  useEffect(() => {
    document.title = `${section.replace(/^./, (v) => v.toUpperCase())} · Krine`;
  }, [section]);
  function signedIn() {
    setError(null);
    if (api.current?.authentication_method === "installation_recovery")
      navigate("/settings?view=operators", { replace: true });
    channel.current?.postMessage("changed");
  }
  function switchOperator() {
    api.clear();
    setError(null);
    channel.current?.postMessage("changed");
  }
  async function logout() {
    setBusy(true);
    setError(null);
    try {
      await api.run(mutation("/session", {}, "DELETE"));
      setConfirmSignout(false);
      switchOperator();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setConfirmSignout(false);
        switchOperator();
      } else setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Link className="brand" to="/">
          Krine<span className="deployment">{window.location.host}</span>
        </Link>
        {session && (
          <>
            {can("investigate") && (
              <nav aria-label="Main navigation">
                {[
                  ["overview", "/", "Overview"],
                  ["checks", "/checks", "Checks"],
                  ["activity", "/activity", "Activity"],
                  ["metrics", "/metrics", "Metrics"],
                ].map(([key, path, label]) => (
                  <Link
                    key={key}
                    to={path!}
                    aria-current={section === key ? "page" : undefined}
                    className={section === key ? "active" : undefined}
                  >
                    {label}
                  </Link>
                ))}
              </nav>
            )}
            <div className="header-utilities">
              <NavLink to="/settings">Settings</NavLink>
              <span className="operator-name">
                {session.operator?.name ?? "Recovery"}
              </span>
              <button disabled={busy} onClick={() => setConfirmSignout(true)}>
                Sign out
              </button>
            </div>
          </>
        )}
      </header>
      <main id="main" tabIndex={-1}>
        {initialized && methods && !session && error && <Notice>{error}</Notice>}
        {!initialized ? (
          <Loading />
        ) : !methods ? (
          <Notice retry={() => void reloadMethods()}>
            {error ?? "Sign-in methods could not be loaded."}
          </Notice>
        ) : session ? (
          <div key={epoch}>
            {session.authentication_method === "installation_recovery" ? (
              <aside className="recovery-banner">
                <strong>Restricted recovery</strong>
                <p>Operator access only. {session.recovery_reason}</p>
                <p>
                  Expires <Time at={session.expires_at} />.
                </p>
              </aside>
            ) : (
              <InstallationContext />
            )}
            {legacy && (
              <Notice>
                Earlier browser recovery records have no operator identity. They
                remain untouched and will not be replayed. Inspect the
                corresponding resource and audit before creating a new change.
              </Notice>
            )}
            {error && !suspended && <Notice>{error}</Notice>}
            {!can("investigate") && location.pathname !== "/settings" ? (
              <>
                <h1>Operator access only.</h1>
                <p>
                  This recovery session cannot inspect customer history or
                  configuration.
                </p>
                <Link to="/settings?view=operators">Manage operators</Link>
              </>
            ) : (
              <Outlet />
            )}
          </div>
        ) : (
          <SignIn
            methods={methods}
            onSignedIn={signedIn}
            onSwitch={switchOperator}
            reloadMethods={reloadMethods}
          />
        )}
      </main>
      <dialog ref={dialog} onCancel={(e) => e.preventDefault()}>
        {suspended && session && methods ? (
          revealedCredential ? (
            <div className="login-form">
              <p>
                Your session has ended. Save this already-issued credential
                before signing in again.
              </p>
              <CredentialReveal
                value={revealedCredential}
                onSaved={() => api.revealCredential(null)}
              />
            </div>
          ) : session.authentication_method === "installation_recovery" ? (
            <div className="login-form">
              <h1>Recovery session ended.</h1>
              <p>
                Arm a new host grant to continue. Requests remain unconfirmed
                until their effects are inspected.
              </p>
              <button onClick={switchOperator}>Return to sign in</button>
            </div>
          ) : (
            <SignIn
              key={session.actor_id}
              methods={methods}
              previous={session}
              onSignedIn={signedIn}
              onSwitch={switchOperator}
              reloadMethods={reloadMethods}
            />
          )
        ) : null}
      </dialog>
      <dialog
        ref={signoutDialog}
        onCancel={() => setConfirmSignout(false)}
        aria-labelledby="signout-title"
      >
        <h2 id="signout-title">Sign out?</h2>
        <p>
          Save open changes and copy newly revealed credentials first.
          Unconfirmed changes may already have succeeded; inspect their
          resources before repeating them.
        </p>
        {error && <Notice>{error}</Notice>}
        <div className="actions">
          <button disabled={busy} onClick={() => void logout()}>
            {busy ? "Signing out…" : "Confirm sign out"}
          </button>
          <button disabled={busy} onClick={() => setConfirmSignout(false)}>
            Stay signed in
          </button>
        </div>
      </dialog>
      <footer className="site-footer">
        Krine · Self-hosted trust decisions
      </footer>
    </>
  );
}
