import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { api, session, type Health, type Stats } from "../api";
import { usePoll } from "../hooks/usePoll";

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export type ThemePref = "system" | "light" | "dark";

interface AppContextValue {
  health: Health;
  /** Re-reads /api/health (e.g. after the default AI model or its key changes). */
  refreshHealth: () => void;
  user: string;
  setUser: (name: string) => void;
  stats: Stats | undefined;
  refreshStats: () => void;
  toast: (message: string, kind?: ToastKind) => void;
  theme: ThemePref;
  setTheme: (theme: ThemePref) => void;
  signOut: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

const THEME_KEY = "haley.theme";

function readTheme(): ThemePref {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: ThemePref) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

applyTheme(readTheme());

export function AppProvider({ health: initialHealth, onSignOut, children }: { health: Health; onSignOut: () => void; children: ReactNode }) {
  const [user, setUserState] = useState(session.user);
  const [theme, setThemeState] = useState<ThemePref>(readTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  // Stats drive the approvals badge and dashboard tiles; poll gently in the background.
  const statsPoll = usePoll(() => api.stats(), [], 10_000);
  // Health says whether the default AI model has credentials; it changes when models are edited.
  const healthPoll = usePoll(() => api.health(), [], 60_000);
  const health = healthPoll.data ?? initialHealth;

  const toast = useCallback((message: string, kind: ToastKind = "success") => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4000);
  }, []);

  const setUser = useCallback((name: string) => {
    session.setUser(name);
    setUserState(session.user);
  }, []);

  const setTheme = useCallback((next: ThemePref) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
    applyTheme(next);
    setThemeState(next);
  }, []);

  const { reload: reloadStats } = statsPoll;
  const refreshStats = useCallback(() => void reloadStats(), [reloadStats]);
  const { reload: reloadHealth } = healthPoll;
  const refreshHealth = useCallback(() => void reloadHealth(), [reloadHealth]);

  const value = useMemo<AppContextValue>(
    () => ({ health, refreshHealth, user, setUser, stats: statsPoll.data, refreshStats, toast, theme, setTheme, signOut: onSignOut }),
    [health, refreshHealth, user, setUser, statsPoll.data, refreshStats, toast, theme, setTheme, onSignOut],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === "success" ? <CircleCheck className="icon" /> : t.kind === "error" ? <CircleAlert className="icon" /> : <Info className="icon" />}
            <span className="toast-msg">{t.message}</span>
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
              <X className="icon-sm" />
            </button>
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}

/** Whether the default AI model has credentials (older servers only report claudeCredentials). */
export const aiReady = (health: Health) => health.aiConfigured ?? health.claudeCredentials;
