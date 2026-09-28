import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-block" role="status">
      <LoaderCircle className="icon spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: Error | string; onRetry?: () => void }) {
  return (
    <div className="banner banner-error" role="alert">
      <CircleAlert className="icon" aria-hidden="true" />
      <span className="spacer">{typeof error === "string" ? error : error.message}</span>
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          <RefreshCw className="icon-sm" aria-hidden="true" /> Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? "empty-compact" : ""}`}>
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="row row-wrap">{actions}</div>}
    </div>
  );
}

export function Spinner() {
  return <LoaderCircle className="icon-sm spinner" aria-hidden="true" />;
}
