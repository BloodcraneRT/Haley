import { Pencil, Plus, RotateCcw, UserMinus, UserPlus, UsersRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, errorMessage, type Technician } from "../api";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { ConfirmModal, Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { TeamSettingsCard } from "../components/TeamSettings";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";

const SLACK_ID = /^[UW][A-Z0-9]{2,20}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The MSP's technicians. Names are the dashboard sign-in names that client rules use for approvers; Slack and
 * Teams accounts let a technician decide approvals from chat, and are linked by email on their first click.
 */
export function TechniciansPage() {
  const { toast, user } = useApp();
  const directory = usePoll(() => api.technicians(), []);
  const [editing, setEditing] = useState<Technician | { name: string } | null>(null);
  const [deactivating, setDeactivating] = useState<Technician | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (key: string, work: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await work();
      toast(message);
      return true;
    } catch (err) {
      toast(errorMessage(err), "error");
      return false;
    } finally {
      setBusy(null);
      void directory.reload();
    }
  };

  const d = directory.data;
  const me = d?.technicians.find((t) => t.name.toLowerCase() === user.trim().toLowerCase());
  return (
    <>
      <PageHeader
        title="Technicians"
        subtitle="Who can approve Haley's changes, from the dashboard, Slack or Teams."
        actions={
          <button className="btn btn-primary" onClick={() => setEditing({ name: "" })}>
            <Plus className="icon-sm" aria-hidden="true" /> Add technician
          </button>
        }
      />
      {directory.error && !d && <ErrorBanner error={directory.error} onRetry={directory.reload} />}
      {!d ? (
        !directory.error && <Loading />
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {!me && user.trim() && (
            <div className="banner banner-info" role="status">
              <UserPlus className="icon-sm" aria-hidden="true" />
              <span style={{ flex: 1 }}>You're signed in as {user.trim()}, who isn't in the directory yet.</span>
              <button className="btn btn-sm" onClick={() => setEditing({ name: user.trim() })}>
                Add yourself
              </button>
            </div>
          )}

          {d.suggestions.length > 0 && (
            <section className="card" aria-labelledby="tech-suggest">
              <div className="card-body stack-sm">
                <h2 id="tech-suggest" className="similar-subhead" style={{ margin: 0 }}>
                  Names already in use
                </h2>
                <p className="secondary" style={{ margin: 0 }}>
                  People who signed in recently or are named as approvers in client rules.
                </p>
                <div className="row row-wrap" style={{ gap: 6 }}>
                  {d.suggestions.map((name) => (
                    <button key={name} className="btn btn-sm" onClick={() => setEditing({ name })} disabled={busy !== null}>
                      <Plus className="icon-sm" aria-hidden="true" /> {name}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}

          <section className="card" aria-labelledby="tech-list">
            <div className="card-header">
              <h2 id="tech-list">Directory</h2>
              <span className="count">{d.technicians.filter((t) => t.active).length}</span>
              {busy && <Spinner />}
            </div>
            {d.technicians.length === 0 ? (
              <EmptyState icon={<UsersRound className="icon" />} title="No technicians yet" compact>
                Add the people who work tickets and approve changes. Use the name each one signs in to the dashboard with.
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table technicians-table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col" className="hide-sm">
                        Email
                      </th>
                      <th scope="col">Chat approvals</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.technicians.map((t) => (
                      <tr key={t.id} className={t.active ? "" : "is-muted"}>
                        <td className="cell-title">
                          {t.name} {t.id === me?.id && <Pill tone="blue">You</Pill>} {!t.active && <Pill>Inactive</Pill>}
                          <div className="cell-sub hide-sm-up">{t.email ?? "No email"}</div>
                        </td>
                        <td className="hide-sm">{t.email ?? <span className="muted">None</span>}</td>
                        <td>
                          <span className="row row-wrap" style={{ gap: 6 }}>
                            <Pill tone={t.slack_user_id ? "green" : "neutral"}>{t.slack_user_id ? "Slack linked" : "Slack"}</Pill>
                            <Pill tone={t.teams_aad_id ? "green" : "neutral"}>{t.teams_aad_id ? "Teams linked" : "Teams"}</Pill>
                          </span>
                          {!t.email && !t.slack_user_id && !t.teams_aad_id && t.active && <div className="cell-sub">Add an email to link chat accounts</div>}
                        </td>
                        <td className="col-actions">
                          <button className="btn btn-sm btn-ghost btn-icon" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`} title="Edit" disabled={busy !== null}>
                            <Pencil className="icon-sm" aria-hidden="true" />
                          </button>
                          {t.active ? (
                            <button
                              className="btn btn-sm btn-ghost btn-icon"
                              onClick={() => setDeactivating(t)}
                              aria-label={`Deactivate ${t.name}`}
                              title="Deactivate"
                              disabled={busy !== null}
                            >
                              <UserMinus className="icon-sm" aria-hidden="true" />
                            </button>
                          ) : (
                            <button
                              className="btn btn-sm btn-ghost btn-icon"
                              onClick={() => void act(t.id, () => api.updateTechnician(t.id, { active: true }), `${t.name} is active again.`)}
                              aria-label={`Reactivate ${t.name}`}
                              title="Reactivate"
                              disabled={busy !== null}
                            >
                              <RotateCcw className="icon-sm" aria-hidden="true" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <TeamSettingsCard />
          <p className="secondary" style={{ margin: 0 }}>
            Slack and Teams accounts are linked automatically the first time a technician clicks an approval card, by matching the email on their chat account
            to the one here. Renaming a technician also renames them in client rules that name them as an approver.
          </p>
        </div>
      )}

      <TechnicianModal
        target={editing}
        busy={busy === "modal"}
        onClose={() => { if (busy === null) setEditing(null); }}
        onSave={async (input) => {
          const target = editing;
          const ok = await act(
            "modal",
            () => (target && "id" in target ? api.updateTechnician(target.id, input) : api.addTechnician({ name: input.name, ...(input.email ? { email: input.email } : {}) })),
            target && "id" in target ? "Saved." : `${input.name} added.`,
          );
          if (ok) setEditing(null);
        }}
      />
      <ConfirmModal
        open={deactivating !== null}
        title={`Deactivate ${deactivating?.name ?? ""}?`}
        confirmLabel="Deactivate"
        busy={busy === deactivating?.id}
        onClose={() => { if (busy === null) setDeactivating(null); }}
        onConfirm={async () => {
          if (!deactivating) return;
          const target = deactivating;
          if (await act(target.id, () => api.deleteTechnician(target.id), `${target.name} deactivated.`)) setDeactivating(null);
        }}
      >
        They can't decide approvals from Slack or Teams any more. Their name stays on past approvals and in the audit log, and you can reactivate them later.
      </ConfirmModal>
    </>
  );
}

type TechnicianInput = { name: string; email: string | null; slackUserId: string | null; teamsAadId: string | null };

function TechnicianModal({
  target,
  busy,
  onClose,
  onSave,
}: {
  target: Technician | { name: string } | null;
  busy: boolean;
  onClose: () => void;
  onSave: (input: TechnicianInput) => void;
}) {
  const existing = target && "id" in target ? target : null;
  const [draft, setDraft] = useState({ name: "", email: "", slack: "", teams: "" });
  const [lastKey, setLastKey] = useState<string | null>(null);
  const key = target ? (existing?.id ?? `new:${target.name}`) : null;
  if (key !== lastKey) {
    setLastKey(key);
    setDraft({ name: target?.name ?? "", email: existing?.email ?? "", slack: existing?.slack_user_id ?? "", teams: existing?.teams_aad_id ?? "" });
  }
  const name = draft.name.trim();
  const email = draft.email.trim();
  const slack = draft.slack.trim();
  const teams = draft.teams.trim();
  const problem = !name
    ? "Enter a name."
    : email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? "Enter a valid email, or leave it empty."
      : slack && !SLACK_ID.test(slack)
        ? "Slack user ids look like U0123ABCD."
        : teams && !GUID.test(teams)
          ? "Teams ids are Entra object ids (a GUID)."
          : null;
  const renamed = existing && name && name !== existing.name;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || busy) return;
    onSave({ name, email: email || null, slackUserId: slack || null, teamsAadId: teams || null });
  };
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={existing ? `Edit ${existing.name}` : "Add technician"}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="technician-form" disabled={problem !== null || busy}>
            {busy ? "Saving…" : existing ? "Save" : "Add"}
          </button>
        </>
      }
    >
      <form id="technician-form" className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="tech-name">Name</label>
          <input id="tech-name" className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} autoFocus />
          <span className="help">The name they sign in to the dashboard with. Client rules name approvers this way.</span>
          {renamed && <span className="help">Rules that name {existing.name} as an approver will be updated to {name}.</span>}
        </div>
        <div className="field">
          <label htmlFor="tech-email">Work email</label>
          <input id="tech-email" className="input" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          <span className="help">Used to link their Slack and Teams accounts.</span>
        </div>
        {existing && (
          <>
            <div className="field">
              <label htmlFor="tech-slack">Slack user id</label>
              <input id="tech-slack" className="input mono" value={draft.slack} onChange={(e) => setDraft({ ...draft, slack: e.target.value })} placeholder="Linked on first click" />
            </div>
            <div className="field">
              <label htmlFor="tech-teams">Teams (Entra) object id</label>
              <input id="tech-teams" className="input mono" value={draft.teams} onChange={(e) => setDraft({ ...draft, teams: e.target.value })} placeholder="Linked on first click" />
              <span className="help">Clear either one to unlink that account.</span>
            </div>
          </>
        )}
        {problem && name && (
          <p className="error-text" role="alert">
            {problem}
          </p>
        )}
      </form>
    </Modal>
  );
}
