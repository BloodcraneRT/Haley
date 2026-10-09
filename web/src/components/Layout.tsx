import {
  ArrowLeftRight,
  BookOpen,
  BrainCircuit,
  Building,
  CircleAlert,
  Coins,
  Inbox,
  LayoutDashboard,
  Lightbulb,
  Menu,
  MessagesSquare,
  Radio,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Ticket,
  Zap,
  UsersRound,
} from "lucide-react";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { aiReady, useApp } from "../lib/app-context";
import { Avatar } from "./Avatar";
import { Loading } from "./Feedback";

function NavItem({ to, icon, children, badge, end }: { to: string; icon: ReactNode; children: ReactNode; badge?: number; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
      {icon}
      <span>{children}</span>
      {badge ? (
        <span className="nav-badge" aria-label={`${badge} awaiting approval`}>
          {badge}
        </span>
      ) : null}
    </NavLink>
  );
}

export function Wordmark() {
  return (
    <>
      <span className="brand-mark" aria-hidden="true">
        <Sparkles className="icon-sm" />
      </span>
      <span className="brand-name">Haley</span>
    </>
  );
}

export function Layout() {
  const { stats, health, user } = useApp();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const pending = stats?.awaitingApproval ?? 0;
  const ready = aiReady(health);
  const defaultName = health.defaultModel?.name ?? health.model;

  useEffect(() => setNavOpen(false), [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    <div className={`shell ${navOpen ? "nav-open" : ""}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Primary">
        <Link to="/" className="brand">
          <Wordmark />
          <span className="brand-sub">MSP</span>
        </Link>
        <nav className="nav">
          <NavItem to="/" end icon={<LayoutDashboard className="icon" aria-hidden="true" />}>
            Dashboard
          </NavItem>
          <NavItem to="/approvals" icon={<ShieldCheck className="icon" aria-hidden="true" />} badge={pending}>
            Approvals
          </NavItem>
          <NavItem to="/tickets" icon={<Ticket className="icon" aria-hidden="true" />}>
            Tickets
          </NavItem>
          <NavItem to="/tasks" icon={<Zap className="icon" aria-hidden="true" />}>
            Ask Haley
          </NavItem>
          <NavItem to="/runs" icon={<Inbox className="icon" aria-hidden="true" />}>
            Runs
          </NavItem>
          <div className="nav-section">Workspace</div>
          <NavItem to="/clients" icon={<Building className="icon" aria-hidden="true" />}>
            Clients
          </NavItem>
          <NavItem to="/channels" icon={<Radio className="icon" aria-hidden="true" />}>
            Channels
          </NavItem>
          <NavItem to="/simulate" icon={<MessagesSquare className="icon" aria-hidden="true" />}>
            Try as end user
          </NavItem>
          <NavItem to="/psa" icon={<ArrowLeftRight className="icon" aria-hidden="true" />}>
            PSA sync
          </NavItem>
          <NavItem to="/technicians" icon={<UsersRound className="icon" aria-hidden="true" />}>
            Technicians
          </NavItem>
          <NavItem to="/models" icon={<BrainCircuit className="icon" aria-hidden="true" />}>
            AI models
          </NavItem>
          <NavItem to="/usage" icon={<Coins className="icon" aria-hidden="true" />}>
            Usage &amp; billing
          </NavItem>
          <NavItem to="/insights" icon={<Lightbulb className="icon" aria-hidden="true" />}>
            What would Haley handle?
          </NavItem>
          <NavItem to="/kb" icon={<BookOpen className="icon" aria-hidden="true" />}>
            Knowledge base
          </NavItem>
          <NavItem to="/audit" icon={<ScrollText className="icon" aria-hidden="true" />}>
            Audit log
          </NavItem>
        </nav>
        <div className="sidebar-footer">
          <Link
            to="/models"
            className="server-status"
            title={
              health.defaultModel
                ? `Default model: ${health.defaultModel.name} (${health.defaultModel.provider}/${health.defaultModel.model})${ready ? "" : ". No credentials."}`
                : "No AI model configured"
            }
          >
            <span className={`pill pill-dot ${ready ? "tone-green" : "tone-amber"}`} style={{ padding: 0, background: "none" }} />
            <span className="truncate">
              {ready ? (
                <>
                  Agent: <span className="server-status-model">{defaultName}</span>
                </>
              ) : health.defaultModel ? (
                `Agent offline: ${defaultName} has no key`
              ) : (
                "Agent offline: no AI model"
              )}
            </span>
          </Link>
          <NavLink to="/settings" className={({ isActive }) => `user-chip ${isActive ? "active" : ""}`} style={{ textDecoration: "none" }}>
            <Avatar name={user || "?"} />
            <span className="truncate" style={{ flex: 1 }}>
              {user || "Set your name"}
            </span>
            <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
              Settings
            </span>
          </NavLink>
        </div>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />

      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-icon" aria-label="Open navigation" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
            <Menu className="icon" />
          </button>
          <Link to="/" className="brand" style={{ padding: 0 }}>
            <Wordmark />
          </Link>
          <span className="spacer" />
          {pending > 0 && (
            <Link to="/approvals" className="pill tone-amber pill-dot" aria-label={`${pending} awaiting approval`}>
              {pending} to approve
            </Link>
          )}
        </header>
        {!ready && (
          <div className="banner banner-warn global-banner" role="status">
            <CircleAlert className="icon" aria-hidden="true" />
            <span className="spacer">
              <strong>Haley can't run yet.</strong>{" "}
              {health.defaultModel ? (
                <>
                  Haley's default model (<strong>{health.defaultModel.name}</strong>) has no credentials: add a key on the AI models page
                  {health.defaultModel.provider === "anthropic" ? <> or set <code>ANTHROPIC_API_KEY</code> on the server</> : null}.
                </>
              ) : (
                <>No AI model is configured. Add one on the AI models page.</>
              )}{" "}
              Until then, runs fail immediately; everything else works.
            </span>
            {location.pathname !== "/models" && (
              <Link to="/models" className="btn btn-sm nowrap">
                <BrainCircuit className="icon-sm" aria-hidden="true" /> AI models
              </Link>
            )}
          </div>
        )}
        <main id="main" className="content" tabIndex={-1}>
          <Suspense fallback={<Loading label="Loading page…" />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
