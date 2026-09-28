import { Check, Copy, KeyRound, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { useApp } from "../lib/app-context";
import { copyText } from "../lib/clipboard";
import { humanize } from "../lib/format";
import { Spinner } from "./Feedback";
import { Modal } from "./Modal";

export function RevealSecretButton({ actionId, size = "sm" }: { actionId: string; size?: "sm" | "md" }) {
  const { toast, user } = useApp();
  const [secrets, setSecrets] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const reveal = async () => {
    setBusy(true);
    try {
      setSecrets(await api.reveal(actionId));
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setSecrets(null);
    setCopied(null);
  };

  return (
    <>
      <button className={`btn ${size === "sm" ? "btn-sm" : ""}`} onClick={reveal} disabled={busy}>
        {busy ? <Spinner /> : <KeyRound className="icon-sm" aria-hidden="true" />}
        Reveal temporary password
      </button>
      <Modal
        open={secrets !== null}
        onClose={close}
        title="Temporary credentials"
        size="narrow"
        footer={
          <button className="btn btn-primary" onClick={close}>
            Done
          </button>
        }
      >
        <div className="banner banner-warn">
          <ShieldAlert className="icon" aria-hidden="true" />
          <span>
            This reveal was recorded in the audit log{user ? ` as ${user}` : ""}. Deliver it to the user by phone or SMS, never by email to
            the same mailbox. It won't be shown again after you close this.
          </span>
        </div>
        <div className="secret-box">
          {secrets &&
            Object.entries(secrets).map(([key, value]) => (
              <div className="secret-row" key={key}>
                <span className="key">{humanize(key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase())}</span>
                <span className="value">{value}</span>
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    if (await copyText(value)) {
                      setCopied(key);
                      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
                    }
                  }}
                  aria-label={`Copy ${key}`}
                >
                  {copied === key ? <Check className="icon-sm" aria-hidden="true" /> : <Copy className="icon-sm" aria-hidden="true" />}
                  {copied === key ? "Copied" : "Copy"}
                </button>
              </div>
            ))}
          {secrets && Object.keys(secrets).length === 0 && <p className="muted">No stored secrets for this action.</p>}
        </div>
      </Modal>
    </>
  );
}
