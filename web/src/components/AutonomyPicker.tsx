import { CircleCheck, Eye, ShieldCheck, Zap } from "lucide-react";
import type { Autonomy } from "../api";
import { AUTONOMY_META } from "../lib/format";

const ICONS: Record<Autonomy, typeof Eye> = { read_only: Eye, supervised: ShieldCheck, autonomous: Zap };
const ORDER: Autonomy[] = ["read_only", "supervised", "autonomous"];

export function AutonomyPicker({ value, onChange, disabled }: { value: Autonomy; onChange: (a: Autonomy) => void; disabled?: boolean }) {
  return (
    <div className="autonomy-options" role="radiogroup" aria-label="Autonomy">
      {ORDER.map((a) => {
        const meta = AUTONOMY_META[a];
        const Icon = ICONS[a];
        const selected = value === a;
        return (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={selected}
            className="choice"
            disabled={disabled}
            onClick={() => onChange(a)}
            onKeyDown={(e) => {
              const i = ORDER.indexOf(a);
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                onChange(ORDER[(i + 1) % ORDER.length]);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                onChange(ORDER[(i + ORDER.length - 1) % ORDER.length]);
              }
            }}
            tabIndex={selected ? 0 : -1}
          >
            {selected && <CircleCheck className="icon choice-selected-mark" aria-hidden="true" />}
            <span className="choice-title">
              <Icon className="icon-sm" aria-hidden="true" />
              {meta.label}
            </span>
            <span className="choice-desc">
              <strong style={{ color: "var(--text-2)", fontWeight: 560 }}>{meta.summary}</strong> {meta.detail}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The approval matrix from server/src/agent/policy.ts, for reference next to the picker. */
export function PolicyMatrix() {
  const cell = (d: "run" | "approve" | "block") =>
    d === "run" ? <span className="pill tone-green">Runs</span> : d === "approve" ? <span className="pill tone-amber">Approval</span> : <span className="pill">Blocked</span>;
  return (
    <div className="table-wrap">
      <table className="policy-table">
        <thead>
          <tr>
            <th scope="col">Policy</th>
            <th scope="col">Read</th>
            <th scope="col">Internal</th>
            <th scope="col">Write</th>
            <th scope="col">Destructive</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Read-only</th>
            <td>{cell("run")}</td>
            <td>{cell("run")}</td>
            <td>{cell("block")}</td>
            <td>{cell("block")}</td>
          </tr>
          <tr>
            <th scope="row">Supervised</th>
            <td>{cell("run")}</td>
            <td>{cell("run")}</td>
            <td>{cell("approve")}</td>
            <td>{cell("approve")}</td>
          </tr>
          <tr>
            <th scope="row">Autonomous</th>
            <td>{cell("run")}</td>
            <td>{cell("run")}</td>
            <td>{cell("run")}</td>
            <td>{cell("approve")}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
