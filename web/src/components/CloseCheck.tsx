import { CircleAlert, Info } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { QaResult } from "../api";
import { Modal } from "./Modal";

/**
 * "Before you close": what the checks found on a ticket a technician is about to resolve or close. In
 * "require" mode, closing despite a warning needs a reason (audited); hints never block.
 */
export function CloseCheckModal({
  check,
  statusLabel,
  busy,
  onClose,
  onCloseAnyway,
  onReply,
}: {
  check: QaResult | null;
  statusLabel: string;
  busy: boolean;
  onClose: () => void;
  onCloseAnyway: (reason: string) => void;
  onReply: () => void;
}) {
  const [reason, setReason] = useState("");
  const warnings = check?.issues.filter((i) => i.level === "warning") ?? [];
  const needsReason = check?.mode === "require" && warnings.length > 0;
  const ready = !needsReason || reason.trim().length >= 3;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !busy) onCloseAnyway(reason.trim());
  };
  return (
    <Modal
      open={check !== null}
      onClose={() => {
        if (busy) return;
        setReason("");
        onClose();
      }}
      title="Before you close"
      size="narrow"
      footer={
        <>
          <button className="btn" type="button" onClick={onReply} disabled={busy}>
            Write a reply
          </button>
          <span className="spacer" />
          <button className="btn btn-primary" type="submit" form="close-check-form" disabled={!ready || busy}>
            {busy ? "Saving…" : `Mark ${statusLabel.toLowerCase()} anyway`}
          </button>
        </>
      }
    >
      <form id="close-check-form" className="stack" onSubmit={submit}>
        <ul className="close-check-list">
          {check?.issues.map((i) => (
            <li key={`${i.code}:${i.text}`} className={i.level === "warning" ? "is-warning" : "is-hint"}>
              {i.level === "warning" ? <CircleAlert className="icon-sm" aria-hidden="true" /> : <Info className="icon-sm" aria-hidden="true" />}
              <span>{i.text}</span>
            </li>
          ))}
        </ul>
        {check?.modelChecked && <p className="help" style={{ margin: 0 }}>Includes suggestions from the AI model.</p>}
        <div className="field">
          <label htmlFor="close-check-reason">{needsReason ? "Reason to close anyway (required)" : "Reason to close anyway (optional)"}</label>
          <input
            id="close-check-reason"
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="e.g. Answered by phone"
          />
          {needsReason && <span className="help">Your workspace requires a reason; it's recorded in the audit log.</span>}
        </div>
      </form>
    </Modal>
  );
}
