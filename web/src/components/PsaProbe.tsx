import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage, type PsaConnection, type PsaProbe } from "../api";
import { ErrorBanner, Loading } from "./Feedback";
import { Modal } from "./Modal";

const METHOD_LABELS: Record<string, string> = {
  test: "Connection",
  listClosedTickets: "Closed tickets (reports)",
  getTicket: "One ticket (sync)",
};

/**
 * Runs the read-only probe on a PSA connection and shows which fields came back and how often they were filled
 * in, so a query built from the vendor's docs can be checked against a live tenant. No values are shown.
 */
export function PsaProbeModal({ connection, open, onClose }: { connection: PsaConnection; open: boolean; onClose: () => void }) {
  const [probe, setProbe] = useState<PsaProbe | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProbe(null);
    setError(null);
    api
      .probePsa(connection.id)
      .then((p) => !cancelled && setProbe(p))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [open, connection.id]);

  return (
    <Modal
      open={open}
      title={`Check fields: ${connection.name}`}
      onClose={onClose}
      size="wide"
      footer={
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="secondary" style={{ marginTop: 0 }}>
        Reads a few recent tickets and lists the fields that came back and how often they were filled in. Nothing is changed and no ticket content is shown. Empty
        fields that should have values point to a query that needs adjusting for your PSA.
      </p>
      {error ? (
        <ErrorBanner error={error} />
      ) : !probe ? (
        <Loading label="Reading from the PSA…" />
      ) : (
        <div className="stack probe-steps" style={{ gap: 14 }}>
          {probe.steps.map((s) => (
            <section key={s.method} className={`probe-step ${s.ok ? "" : "is-error"}`}>
              <header className="row" style={{ gap: 6 }}>
                {s.ok ? <CircleCheck className="icon-sm probe-ok" aria-label="Worked" /> : <CircleAlert className="icon-sm probe-fail" aria-label="Failed" />}
                <strong>{METHOD_LABELS[s.method] ?? s.method}</strong>
                <span className="muted">· {s.detail}</span>
              </header>
              {s.fields.length > 0 && (
                <div className="table-wrap">
                  <table className="table probe-table">
                    <thead>
                      <tr>
                        <th scope="col">Field</th>
                        <th scope="col">Type</th>
                        <th scope="col">Filled in</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.fields.map((f) => (
                        <tr key={f.field} className={f.filled === 0 ? "is-empty" : ""}>
                          <td className="mono">{f.field}</td>
                          <td>{f.types.join(" or ")}</td>
                          <td>
                            {f.filled} of {f.total}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
