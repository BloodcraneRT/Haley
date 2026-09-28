import { CircleAlert, KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, ApiError, errorMessage, session, type Health } from "../api";
import { Spinner } from "../components/Feedback";
import { Wordmark } from "../components/Layout";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function SignIn({ health, notice, onDone }: { health: Health; notice?: string; onDone: () => void }) {
  useDocumentTitle("Sign in");
  const needsToken = health.authRequired;
  const [token, setToken] = useState(needsToken ? session.token : "");
  const [name, setName] = useState(session.user);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Enter your name so actions are attributed to you.");
    if (needsToken && !token.trim()) return setError("Enter the API token.");
    setBusy(true);
    const previous = session.token;
    session.setToken(needsToken ? token : previous);
    session.setUser(name);
    try {
      // Any authenticated endpoint verifies the token.
      await api.stats();
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        session.setToken("");
        setError("That token was rejected by the server. Check HALEY_API_TOKEN and try again.");
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <form className="card signin-card stack" onSubmit={submit} noValidate>
        <div className="brand">
          <Wordmark />
        </div>
        <div>
          <h1 style={{ fontSize: "var(--text-xl)" }}>{needsToken ? "Sign in to Haley" : "Welcome to Haley"}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {needsToken
              ? "This server requires an API token. Your name is recorded on approvals, comments and the audit log."
              : "Tell us who you are. Your name is recorded on approvals, comments and the audit log."}
          </p>
        </div>
        {notice && (
          <div className="banner banner-warn" role="status">
            <CircleAlert className="icon" aria-hidden="true" />
            <span>{notice}</span>
          </div>
        )}
        <div className="field">
          <label htmlFor="signin-name">Technician name</label>
          <input
            id="signin-name"
            className="input"
            autoComplete="name"
            placeholder="e.g. Jordan Reyes"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        {needsToken && (
          <div className="field">
            <label htmlFor="signin-token">API token</label>
            <input
              id="signin-token"
              className="input mono"
              type="password"
              autoComplete="current-password"
              placeholder="HALEY_API_TOKEN"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <span className="help">Stored in this browser only. Ask whoever runs the Haley server for it.</span>
          </div>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? <Spinner /> : needsToken ? <KeyRound className="icon-sm" aria-hidden="true" /> : null}
          {needsToken ? "Sign in" : "Continue"}
        </button>
      </form>
    </div>
  );
}
