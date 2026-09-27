import { RefreshCw, ServerCrash } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Route, Routes, useParams } from "react-router-dom";
import { api, errorMessage, session, UNAUTHORIZED_EVENT, type Health } from "./api";
import { Loading } from "./components/Feedback";
import { Layout } from "./components/Layout";
import { AppProvider } from "./lib/app-context";
import { ApprovalsPage } from "./pages/Approvals";
import { AuditPage } from "./pages/Audit";
import { ClientDetailPage } from "./pages/ClientDetail";
import { ClientsPage } from "./pages/Clients";
import { DashboardPage } from "./pages/Dashboard";
import { KbArticlePage, KbNewPage } from "./pages/KbArticle";
import { KbPage } from "./pages/Kb";
import { NotFoundPage } from "./pages/NotFound";
import { RunDetailPage } from "./pages/RunDetail";
import { RunsPage } from "./pages/Runs";
import { SettingsPage } from "./pages/Settings";
import { SignIn } from "./pages/SignIn";
import { TasksPage } from "./pages/Tasks";
import { TicketDetailPage } from "./pages/TicketDetail";
import { TicketsPage } from "./pages/Tickets";

/** Remounts detail pages when the :id changes so no state leaks between records. */
function Keyed({ children }: { children: ReactNode }) {
  const { id } = useParams();
  return <div key={id}>{children}</div>;
}

type Boot =
  | { state: "loading" }
  | { state: "offline"; message: string }
  | { state: "signin"; health: Health; notice?: string }
  | { state: "ready"; health: Health };

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });

  const start = useCallback(async () => {
    setBoot({ state: "loading" });
    try {
      const health = await api.health();
      if ((health.authRequired && !session.token) || !session.user) setBoot({ state: "signin", health });
      else setBoot({ state: "ready", health });
    } catch (err) {
      setBoot({ state: "offline", message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    const onUnauthorized = () =>
      setBoot((b) => {
        if (b.state !== "ready" && b.state !== "signin") return b;
        session.setToken("");
        return { state: "signin", health: { ...b.health, authRequired: true }, notice: "Your session was rejected by the server. Sign in again." };
      });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signOut = useCallback(() => {
    session.setToken("");
    void start();
  }, [start]);

  if (boot.state === "loading") {
    return (
      <div className="signin">
        <Loading label="Connecting to Haley…" />
      </div>
    );
  }
  if (boot.state === "offline") {
    return (
      <div className="signin">
        <div className="card signin-card">
          <div className="empty">
            <div className="empty-icon">
              <ServerCrash className="icon" aria-hidden="true" />
            </div>
            <h3>Can't reach the Haley server</h3>
            <p>{boot.message} In development, start it with <code>npm run dev</code> in <code>server/</code> (port 8787).</p>
            <div className="row">
              <button className="btn btn-primary" onClick={() => void start()}>
                <RefreshCw className="icon-sm" aria-hidden="true" /> Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (boot.state === "signin") {
    return <SignIn health={boot.health} notice={boot.notice} onDone={() => setBoot({ state: "ready", health: boot.health })} />;
  }

  return (
    <AppProvider health={boot.health} onSignOut={signOut}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="approvals" element={<ApprovalsPage />} />
            <Route path="clients" element={<ClientsPage />} />
            <Route path="clients/:id" element={<Keyed><ClientDetailPage /></Keyed>} />
            <Route path="tickets" element={<TicketsPage />} />
            <Route path="tickets/:id" element={<Keyed><TicketDetailPage /></Keyed>} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="runs" element={<RunsPage />} />
            <Route path="runs/:id" element={<Keyed><RunDetailPage /></Keyed>} />
            <Route path="kb" element={<KbPage />} />
            <Route path="kb/new" element={<KbNewPage />} />
            <Route path="kb/:id" element={<Keyed><KbArticlePage /></Keyed>} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}
