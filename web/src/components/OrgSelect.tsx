import type { Org } from "../api";

export function OrgSelect({
  orgs,
  value,
  onChange,
  id,
  allLabel,
  required,
  className = "select",
}: {
  orgs: Pick<Org, "id" | "name">[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
  /** When set, adds an "all" option with an empty value. */
  allLabel?: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <select id={id} className={className} value={value} onChange={(e) => onChange(e.target.value)} required={required}>
      {allLabel !== undefined ? <option value="">{allLabel}</option> : !value && <option value="">Choose a client…</option>}
      {orgs.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
