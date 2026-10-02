import { RefreshCw, ServerCrash } from "lucide-react";
import { lazy, useCallback, useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Route, Routes, useParams } from "react-router-dom";
import { api, errorMessage, session, UNAUTHORIZED_EVENT, type Health } from "./api";
import { Loading } from "./components/Feedback";
import { Layout } from "./components/Layout";
import { AppProvider } from "./lib/app-context";
import { SignIn } from "./pages/SignIn";

// Load each workspace screen when needed; the shell and sign-in stay immediately available.
const ApprovalsPage = lazy(() => import("./pages/Approvals").then((m) => ({ default: m.ApprovalsPage })));
const AuditPage = lazy(() => import("./pages/Audit").then((m) => ({ default: m.AuditPage })));
const ChannelsPage = lazy(() => import("./pages/Channels").then((m) => ({ default: m.ChannelsPage })));
const ClientDetailPage = lazy(() => import("./pages/ClientDetail").then((m) => ({ default: m.ClientDetailPage })));
const ClientReportPage = lazy(() => import("./pages/ClientReport").then((m) => ({ default: m.ClientReportPage })));
const ClientsPage = lazy(() => import("./pages/Clients").then((m) => ({ default: m.ClientsPage })));
const DashboardPage = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.DashboardPage })));
const KbArticlePage = lazy(() => import("./pages/KbArticle").then((m) => ({ default: m.KbArticlePage })));
const KbNewPage = lazy(() => import("./pages/KbArticle").then((m) => ({ default: m.KbNewPage })));
const KbPage = lazy(() => import("./pages/Kb").then((m) => ({ default: m.KbPage })));
const ModelsPage = lazy(() => import("./pages/Models").then((m) => ({ default: m.ModelsPage })));
const NotFoundPage = lazy(() => import("./pages/NotFound").then((m) => ({ default: m.NotFoundPage })));
const PsaMappingPage = lazy(() => import("./pages/Psa").then((m) => ({ default: m.PsaMappingPage })));
const PsaPage = lazy(() => import("./pages/Psa").then((m) => ({ default: m.PsaPage })));
const RunDetailPage = lazy(() => import("./pages/RunDetail").then((m) => ({ default: m.RunDetailPage })));
const RunsPage = lazy(() => import("./pages/Runs").then((m) => ({ default: m.RunsPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const SimulatorPage = lazy(() => import("./pages/Simulator").then((m) => ({ default: m.SimulatorPage })));
const TasksPage = lazy(() => import("./pages/Tasks").then((m) => ({ default: m.TasksPage })));
const TicketDetailPage = lazy(() => import("./pages/TicketDetail").then((m) => ({ default: m.TicketDetailPage })));
const IncidentDetailPage = lazy(() => import("./pages/IncidentDetail").then((m) => ({ default: m.IncidentDetailPage })));
const UsagePage = lazy(() => import("./pages/Usage").then((m) => ({ default: m.UsagePage })));
const TicketsPage = lazy(() => import("./pages/Tickets").then((m) => ({ default: m.TicketsPage })));

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
    session.setUser("");
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
            <Route path="clients/:id/report" element={<Keyed><ClientReportPage /></Keyed>} />
            <Route path="channels" element={<ChannelsPage />} />
            <Route path="simulate" element={<SimulatorPage />} />
            <Route path="psa" element={<PsaPage />} />
            <Route path="psa/:id/customers" element={<Keyed><PsaMappingPage /></Keyed>} />
            <Route path="models" element={<ModelsPage />} />
            <Route path="tickets" element={<TicketsPage />} />
            <Route path="tickets/:id" element={<Keyed><TicketDetailPage /></Keyed>} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="runs" element={<RunsPage />} />
            <Route path="runs/:id" element={<Keyed><RunDetailPage /></Keyed>} />
            <Route path="kb" element={<KbPage />} />
            <Route path="kb/new" element={<KbNewPage />} />
            <Route path="kb/:id" element={<Keyed><KbArticlePage /></Keyed>} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="incidents/:id" element={<Keyed><IncidentDetailPage /></Keyed>} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}
