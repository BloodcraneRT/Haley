import type { ReactNode } from "react";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
  docTitle,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  /** Browser tab title; defaults to `title` when it's a string. */
  docTitle?: string;
}) {
  useDocumentTitle(docTitle ?? (typeof title === "string" ? title : undefined));
  return (
    <header className="page-header">
      <div style={{ minWidth: 0, flex: "1 1 320px" }}>
        {breadcrumb && <nav className="breadcrumb" aria-label="Breadcrumb">{breadcrumb}</nav>}
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
