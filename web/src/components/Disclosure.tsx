import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { prettyJson } from "../lib/format";

export function Disclosure({
  summary,
  children,
  defaultOpen,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details className={`disclosure ${className ?? ""}`} open={defaultOpen}>
      <summary>
        <ChevronRight className="icon-sm chev" aria-hidden="true" />
        {summary}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function CodeBlock({ value, error }: { value: unknown; error?: boolean }) {
  return <pre className={`code-block ${error ? "error" : ""}`}>{prettyJson(value)}</pre>;
}

export function JsonDisclosure({ label, value, error, defaultOpen }: { label: ReactNode; value: unknown; error?: boolean; defaultOpen?: boolean }) {
  return (
    <Disclosure summary={label} defaultOpen={defaultOpen}>
      <CodeBlock value={value} error={error} />
    </Disclosure>
  );
}
