import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError, errorMessage } from "./api";
import { Notice } from "./shared";
import { validReveal } from "./operator";
import type { AuthMethods, OperatorReveal, OperatorSession } from "./operator";

export function CredentialReveal({
  value,
  onSaved,
}: {
  value: OperatorReveal;
  onSaved: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section
      className="credential-reveal"
      aria-labelledby="operator-credential-title"
    >
      <h2 id="operator-credential-title">
        {value.credential
          ? "Save this sign-in credential."
          : "The credential cannot be shown again."}
      </h2>
      <p>
        <strong>{value.operator.name}</strong> · Sign-in name{" "}
        <code>{value.operator.sign_in_name}</code>
      </p>
      {value.credential ? (
        <>
          <p>
            Save it in a password manager before continuing. Krine shows this
            generated credential once.
          </p>
          <label>
            Sign-in credential
            <input
              name="new-password"
              autoComplete="new-password"
              type="text"
              readOnly
              value={value.credential}
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <div className="actions">
            <button
              onClick={() =>
                void navigator.clipboard
                  .writeText(value.credential!)
                  .then(() => setCopied(true))
                  .catch(() =>
                    setError(
                      "Copy was unavailable. Select the credential and copy it manually.",
                    ),
                  )
              }
            >
              {copied ? "Copied" : "Copy credential"}
            </button>
            <button className="primary" onClick={onSaved}>
              I saved the credential
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            The request succeeded, but its first reveal was lost. An Admin or
            host recovery must rotate this operator’s credential after reviewing
            its current revision.
          </p>
          <button onClick={onSaved}>I understand</button>
        </>
      )}
      {error && <Notice>{error}</Notice>}
    </section>
  );
}

export function SignIn({
  methods,
  previous,
  onSignedIn,
  onSwitch,
  reloadMethods,
}: {
  methods: AuthMethods;
  previous?: OperatorSession | null;
  onSignedIn: () => void;
  onSwitch: () => void;
  reloadMethods: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"local" | "bootstrap" | "recovery">(
    methods.bootstrap && !previous ? "bootstrap" : "local",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<OperatorReveal | null>(null);
  const [consumed, setConsumed] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      if (mode === "bootstrap") {
        setConsumed(true);
        const value = await api.publicPost<unknown>("/auth/bootstrap", {
          installation_secret: String(data.get("installation_secret")),
          name: String(data.get("name")),
          sign_in_name: String(data.get("sign_in_name")),
        });
        if (
          !validReveal(value) ||
          value.secret_status !== "revealed" ||
          value.operator.role !== "admin"
        )
          throw new ApiError(
            200,
            "invalid_response",
            "Enrollment may have succeeded, but its credential could not be read. Use host recovery to restore access; do not enroll again.",
          );
        setReveal(value);
        form.reset();
      } else {
        if (mode === "recovery") {
          setConsumed(true);
          await api.recover(String(data.get("token")));
        } else
          await api.session({
            sign_in_name: String(data.get("sign_in_name")),
            credential: String(data.get("credential")),
          });
        form.reset();
        onSignedIn();
      }
    } catch (cause) {
      if (
        mode === "bootstrap" &&
        cause instanceof ApiError &&
        [401, 422].includes(cause.status) &&
        cause.code !== "invalid_response"
      )
        setConsumed(false);
      setError(
        mode === "recovery"
          ? "This single-use grant did not confirm a session. Ask the host administrator to arm a new recovery grant, then enter its token."
          : errorMessage(cause),
      );
      if (mode === "local") first.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  if (reveal)
    return (
      <div className="login-form">
        <CredentialReveal
          value={reveal}
          onSaved={() => {
            setReveal(null);
            setMode("local");
            setConsumed(false);
            void reloadMethods();
          }}
        />
      </div>
    );
  return (
    <form className="login-form" onSubmit={(e) => void submit(e)}>
      <h1>
        {previous
          ? "Sign in again."
          : mode === "bootstrap"
            ? "Set up operator access."
            : mode === "recovery"
              ? "Recover operator access."
              : "Sign in to Krine."}
      </h1>
      <p className="muted">
        {previous
          ? `Sign in as ${previous.operator?.name ?? "the same recovery operator"} to continue your unsaved work. Requests will not be resubmitted automatically.`
          : mode === "bootstrap"
            ? "Create the first Admin for this installation. Each person will use their own sign-in credential."
            : mode === "recovery"
              ? "Use a short-lived, single-use token armed by your host administrator. Recovery can repair operator access only."
              : "Use your sign-in name and generated credential."}
      </p>
      {mode === "bootstrap" && (
        <>
          <label>
            Installation secret
            <input
              ref={first}
              name="installation_secret"
              type="password"
              autoComplete="off"
              required
            />
          </label>
          <label>
            Your name
            <input name="name" autoComplete="name" maxLength={128} required />
          </label>
        </>
      )}
      {mode !== "recovery" && (
        <label>
          Sign-in name
          <input
            ref={mode === "local" ? first : undefined}
            name="sign_in_name"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            pattern="[A-Za-z0-9_.-]+"
            maxLength={64}
            defaultValue={previous?.operator?.sign_in_name ?? ""}
            readOnly={Boolean(previous?.operator)}
            required
          />
        </label>
      )}
      {mode === "local" && (
        <label>
          Sign-in credential
          <input
            name="credential"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
      )}
      {mode === "recovery" && (
        <label>
          Recovery token
          <input
            ref={first}
            name="token"
            type="password"
            autoComplete="off"
            required
          />
        </label>
      )}
      {error && <Notice>{error}</Notice>}
      {consumed && mode === "bootstrap" ? (
        <p className="help">
          Enrollment may already be complete. Recover operator access if you did
          not save its credential.
        </p>
      ) : (
        <button
          className="primary"
          disabled={busy || (mode === "local" && !methods.local)}
          type="submit"
        >
          {busy
            ? "Working…"
            : mode === "bootstrap"
              ? "Create first Admin"
              : mode === "recovery"
                ? "Start restricted recovery"
                : "Sign in"}
        </button>
      )}
      {mode === "local" && !methods.local && (
        <p className="help">Local sign-in is disabled on this installation.</p>
      )}
      <div className="login-options">
        {previous ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Switch operator? This closes unsaved work and clears revealed credentials. An unconfirmed action may already have succeeded; inspect its resource and audit before repeating it.",
                )
              )
                onSwitch();
            }}
          >
            Switch operator and close this work
          </button>
        ) : (
          <>
            {mode !== "local" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setMode("local");
                  setError(null);
                  setConsumed(false);
                }}
              >
                Back to sign in
              </button>
            )}
            {mode !== "recovery" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setMode("recovery");
                  setError(null);
                  setConsumed(false);
                }}
              >
                Recover operator access
              </button>
            )}
          </>
        )}
      </div>
    </form>
  );
}
