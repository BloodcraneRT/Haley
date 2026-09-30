import { Bot, CircleCheck, Eye, ShieldCheck, Zap } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { AUTONOMY_LEVELS, type Autonomy, type OrgSettings } from "../api";
import { AUTONOMY_META } from "../lib/format";

const ICONS: Record<Autonomy, typeof Eye> = { read_only: Eye, supervised: ShieldCheck, autonomous: Zap, unattended: Bot };
const ORDER: Autonomy[] = AUTONOMY_LEVELS;

export function AutonomyPicker({ value, onChange, disabled }: { value: Autonomy; onChange: (a: Autonomy) => void; disabled?: boolean }) {
  const group = useRef<HTMLDivElement>(null);
  const keyboardFocus = useRef(false);
  useEffect(() => {
    if (!disabled && keyboardFocus.current) {
      // Saving temporarily disables the buttons; restore keyboard focus when they become available.
      if (document.activeElement === document.body || group.current?.contains(document.activeElement)) {
        group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[ORDER.indexOf(value)]?.focus();
      }
      keyboardFocus.current = false;
    }
  }, [disabled, value]);
  return (
    <div ref={group} className="autonomy-options" role="radiogroup" aria-label="Autonomy">
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
              let next: number;
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                next = (i + 1) % ORDER.length;
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                next = (i + ORDER.length - 1) % ORDER.length;
              } else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = ORDER.length - 1;
              else return;
              e.preventDefault();
              keyboardFocus.current = ORDER[next] !== value;
              group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
              onChange(ORDER[next]);
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

type Cell = "run" | "approve" | "block";

const cell = (d: Cell) =>
  d === "run" ? <span className="pill tone-green">Runs</span> : d === "approve" ? <span className="pill tone-amber">Approval</span> : <span className="pill">Blocked</span>;

function Conditional({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="policy-cond">
      <span className="pill tone-teal">{label}</span>
      <span className="policy-cond-note">{children}</span>
    </span>
  );
}

/** The approval matrix from server/src/agent/policy.ts, for reference next to the picker. */
export function PolicyMatrix({ settings, highlight }: { settings?: Pick<OrgSettings, "maxAutoChangesPerHour" | "maxSelfServicePerUserPerDay">; highlight?: Autonomy }) {
  const perDay = settings ? `${settings.maxSelfServicePerUserPerDay} per person per day` : "the daily per-person limit";
  const perHour = settings ? `${settings.maxAutoChangesPerHour} automatic changes an hour` : "the hourly limit";
  const row = (a: Autonomy) => (highlight === a ? "is-current" : undefined);
  return (
    <div className="stack-sm">
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
            <tr className={row("read_only")}>
              <th scope="row">Read-only</th>
              <td>{cell("run")}</td>
              <td>{cell("run")}</td>
              <td>{cell("block")}</td>
              <td>{cell("block")}</td>
            </tr>
            <tr className={row("supervised")}>
              <th scope="row">Supervised</th>
              <td>{cell("run")}</td>
              <td>{cell("run")}</td>
              <td>{cell("approve")}</td>
              <td>{cell("approve")}</td>
            </tr>
            <tr className={row("autonomous")}>
              <th scope="row">Autonomous</th>
              <td>{cell("run")}</td>
              <td>{cell("run")}</td>
              <td>{cell("run")}</td>
              <td>{cell("approve")}</td>
            </tr>
            <tr className={row("unattended")}>
              <th scope="row">Unattended</th>
              <td>{cell("run")}</td>
              <td>{cell("run")}</td>
              <td>
                <Conditional label="Runs if…">
                  it's the requester's own account (email-verified or better), or the requester is an authorized approver. Access grants (groups,
                  mailboxes) always need an authorized approver.
                </Conditional>
              </td>
              <td>
                <Conditional label="Runs if…">
                  it's the requester's own account with a chat or directory identity, within {perDay}; or an authorized approver asks with a chat
                  or directory identity. Email alone never qualifies.
                </Conditional>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul className="policy-notes">
        <li>In every mode, changes to protected accounts wait for a technician.</li>
        <li>
          Unattended: an unverified requester, anything past {perHour}, or anything the rules above don't cover goes to the approval queue instead
          of failing, so the request still gets handled.
        </li>
        <li>Tickets a technician enters, and tasks you start, act with technician authority.</li>
      </ul>
    </div>
  );
}
