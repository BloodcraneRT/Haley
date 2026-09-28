import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { session } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { aiReady, useApp, type ThemePref } from "../lib/app-context";

export function SettingsPage() {
  const { user, setUser, toast, health, theme, setTheme, signOut } = useApp();
  const [name, setName] = useState(user);

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return toast("Name can't be empty.", "error");
    setUser(name);
    toast("Saved. New actions will be attributed to you as " + name.trim() + ".");
  };

  const themes: [ThemePref, string, typeof Sun][] = [
    ["system", "System", Monitor],
    ["light", "Light", Sun],
    ["dark", "Dark", Moon],
  ];

  return (
    <>
      <PageHeader title="Settings" subtitle="Stored in this browser only." />
      <div className="stack" style={{ maxWidth: 640 }}>
        <form className="card" onSubmit={save}>
          <div className="card-header">
            <h2>Technician</h2>
          </div>
          <div className="card-body stack">
            <div className="field">
              <label htmlFor="set-name">Your name</label>
              <input id="set-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              <span className="help">Sent with every request and recorded on approvals, comments, credential reveals and the audit log.</span>
            </div>
          </div>
          <div className="card-footer">
            <span className="spacer" />
            <button className="btn btn-primary btn-sm" type="submit" disabled={!name.trim() || name.trim() === user}>
              Save
            </button>
          </div>
        </form>

        <section className="card">
          <div className="card-header">
            <h2>Appearance</h2>
          </div>
          <div className="card-body">
            <div className="segmented" role="group" aria-label="Theme">
              {themes.map(([value, label, Icon]) => (
                <button key={value} aria-pressed={theme === value} onClick={() => setTheme(value)}>
                  <Icon className="icon-sm" aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 5 }} />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Server</h2>
          </div>
          <div className="card-body">
            <dl className="props" style={{ gridTemplateColumns: "150px minmax(0,1fr)" }}>
              <dt>Default AI model</dt>
              <dd className="row row-wrap" style={{ gap: 8 }}>
                <span>{health.defaultModel?.name ?? "None"}</span>
                <span className="mono muted" style={{ fontSize: "var(--text-sm)" }}>
                  {health.defaultModel ? `${health.defaultModel.provider}/${health.defaultModel.model}` : health.model}
                </span>
                <Link to="/models" style={{ fontSize: "var(--text-sm)" }}>
                  Manage
                </Link>
              </dd>
              <dt>AI credentials</dt>
              <dd>
                {aiReady(health) ? (
                  <Pill tone="green" dot>
                    Configured
                  </Pill>
                ) : (
                  <Pill tone="amber" dot>
                    Missing: add a key on the AI models page
                  </Pill>
                )}
              </dd>
              <dt>API authentication</dt>
              <dd>
                {health.authRequired ? (
                  <Pill tone="green" dot>
                    Token required
                  </Pill>
                ) : (
                  <Pill tone="amber" dot>
                    Open: set HALEY_API_TOKEN before exposing Haley
                  </Pill>
                )}
              </dd>
            </dl>
          </div>
          {health.authRequired && session.token && (
            <div className="card-footer">
              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                Signed in with an API token.
              </span>
              <span className="spacer" />
              <button className="btn btn-sm" onClick={signOut}>
                <LogOut className="icon-sm" aria-hidden="true" /> Sign out
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
