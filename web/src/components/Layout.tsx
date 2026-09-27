import {
  BookOpen,
  Building,
  CircleAlert,
  Inbox,
  LayoutDashboard,
  Menu,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Ticket,
  Zap,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useApp } from "../lib/app-context";
import { Avatar } from "./Avatar";

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
          <NavItem to="/kb" icon={<BookOpen className="icon" aria-hidden="true" />}>
            Knowledge base
          </NavItem>
          <NavItem to="/audit" icon={<ScrollText className="icon" aria-hidden="true" />}>
            Audit log
          </NavItem>
        </nav>
        <div className="sidebar-footer">
          <div className="server-status" title={`Model: ${health.model}`}>
            <span className={`pill pill-dot ${health.claudeCredentials ? "tone-green" : "tone-amber"}`} style={{ padding: 0, background: "none" }} />
            <span className="truncate">{health.claudeCredentials ? health.model : "Agent offline: no Claude key"}</span>
          </div>
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
        {!health.claudeCredentials && (
          <div className="banner banner-warn global-banner" role="status">
            <CircleAlert className="icon" aria-hidden="true" />
            <span>
              <strong>Haley can't run yet.</strong> The server has no Claude credentials. Set <code>ANTHROPIC_API_KEY</code> in the server's
              environment and restart it; until then, runs will fail immediately. Everything else works.
            </span>
          </div>
        )}
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
