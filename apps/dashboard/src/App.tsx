import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { api, errorMessage, mutation } from "./api";
import { Loading, Notice } from "./shared";
import { InstallationContext } from "./Overview";

export function App() {
  const [initialized, setInitialized] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [reauthenticate, setReauthenticate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const location = useLocation();
  useEffect(() => {
    api.onUnauthorized = () => setReauthenticate(true);
    void api
      .session()
      .then(() => setAuthenticated(true))
      .catch(() => {
        /* Login form is the recovery path. */
      })
      .finally(() => setInitialized(true));
    return () => {
      api.onUnauthorized = undefined;
    };
  }, []);
  useEffect(() => {
    if (reauthenticate) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [reauthenticate]);
  const section =
    location.pathname === "/inspect/check"
      ? "checks"
      : location.pathname.startsWith("/inspect/") ||
          location.pathname.startsWith("/entities/")
        ? "activity"
        : location.pathname.split("/")[1] || "overview";
  useEffect(() => {
    document.title = `${section.replace(/^./, (value) => value.toUpperCase())} · Krine`;
  }, [section]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError(null);
    try {
      await api.session(String(new FormData(form).get("password") ?? ""));
      setAuthenticated(true);
      setReauthenticate(false);
      form.reset();
    } catch (cause) {
      setError(errorMessage(cause));
      password.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError(null);
    try {
      await api.run(mutation("/session", {}, "DELETE"));
      api.csrf = "";
      setAuthenticated(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const loginForm = (
    <form className="login-form" onSubmit={(event) => void login(event)}>
      <h1>{reauthenticate ? "Sign in again." : "Sign in to Krine."}</h1>
      <p className="muted">
        Use the administrator password configured for this installation.
        {reauthenticate && " Your unsaved work remains open."}
      </p>
      <label>
        Administrator password
        <input
          ref={password}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      {error && <Notice>{error}</Notice>}
      <button className="primary" disabled={busy} type="submit">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Link className="brand" to="/">
          Krine<span className="deployment">{window.location.host}</span>
        </Link>
        {authenticated && (
          <>
            <nav aria-label="Main navigation">
              <Link to="/" aria-current={section === "overview" ? "page" : undefined} className={section === "overview" ? "active" : undefined}>Overview</Link>
              <Link
                to="/checks"
                aria-current={section === "checks" ? "page" : undefined}
                className={section === "checks" ? "active" : undefined}
              >
                Checks
              </Link>
              <Link
                to="/activity"
                aria-current={section === "activity" ? "page" : undefined}
                className={section === "activity" ? "active" : undefined}
              >
                Activity
              </Link>
              <Link
                to="/metrics"
                aria-current={section === "metrics" ? "page" : undefined}
                className={section === "metrics" ? "active" : undefined}
              >
                Metrics
              </Link>
            </nav>
            <div className="header-utilities">
              <NavLink to="/settings">Settings</NavLink>
              <button
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Sign out? Save open changes and copy any newly revealed secrets before continuing.",
                    )
                  )
                    void logout();
                }}
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </header>
      <main id="main" tabIndex={-1}>
        {!initialized ? (
          <Loading />
        ) : authenticated ? (
          <>
            <InstallationContext />
            {error && !reauthenticate && <Notice>{error}</Notice>}
            <Outlet />
          </>
        ) : (
          loginForm
        )}
      </main>
      <dialog ref={dialog} onCancel={(event) => event.preventDefault()}>
        {authenticated ? loginForm : null}
      </dialog>
      <footer className="site-footer">
        Krine · Self-hosted trust decisions
      </footer>
    </>
  );
}
