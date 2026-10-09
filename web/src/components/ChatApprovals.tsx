import { Send, Unplug } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage, type ApprovalSettingsInput, type ApprovalSettingsView, type ReminderMinutes } from "../api";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { CopyButton } from "./CopyButton";
import { Disclosure } from "./Disclosure";
import { ErrorBanner, Loading } from "./Feedback";
import { Modal } from "./Modal";
import { Pill } from "./Pill";
import { Switch } from "./Switch";

const CHANNEL_RE = /^[CG][A-Z0-9]{2,20}$/;
const REMINDERS: Array<[ReminderMinutes, string]> = [
  [0, "Off"],
  [15, "After 15 minutes"],
  [30, "After 30 minutes"],
  [60, "After an hour"],
  [120, "After 2 hours"],
];
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One line for the Approvals page header: where approval cards go today. */
export function chatApprovalsSummary(s: ApprovalSettingsView | undefined): string {
  if (!s) return "";
  const places = [s.slackConnected && s.slackChannel ? "Slack" : null, s.teamsConversation ? "Teams" : null].filter(Boolean);
  return places.length ? `Cards go to ${places.join(" and ")}` : "Only in the dashboard";
}

/**
 * Where approval cards and escalation notices go in the MSP's own Slack and Teams, and how much can be
 * approved from chat. Clients can override the Slack channel on their Self-service & safety settings.
 */
export function ChatApprovalsModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved?: () => void }) {
  const { toast } = useApp();
  const settings = usePoll(() => (open ? api.approvalSettings() : Promise.resolve(undefined)), [open]);
  const s = settings.data;
  const [token, setToken] = useState("");
  const [channel, setChannel] = useState<string | null>(null);
  const [maxRisk, setMaxRisk] = useState<"write" | "destructive" | null>(null);
  const [notices, setNotices] = useState<boolean | null>(null);
  const [dm, setDm] = useState<boolean | null>(null);
  const [reminder, setReminder] = useState<ReminderMinutes | null>(null);
  const [tenant, setTenant] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "disconnect" | "teams" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const value = {
    channel: channel ?? s?.slackChannel ?? "",
    maxRisk: maxRisk ?? s?.chatApprovalMaxRisk ?? "destructive",
    notices: notices ?? s?.escalationNotices ?? true,
    dm: dm ?? s?.dmApprovers ?? true,
    reminder: reminder ?? s?.reminderMinutes ?? 0,
    tenant: tenant ?? s?.mspTenantId ?? "",
  };
  const close = () => {
    if (busy) return;
    setToken("");
    setChannel(null);
    setMaxRisk(null);
    setNotices(null);
    setDm(null);
    setReminder(null);
    setTenant(null);
    setError(null);
    onClose();
  };

  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<string>) => {
    setBusy(kind);
    setError(null);
    try {
      toast(await work());
      await settings.reload();
      onSaved?.();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ch = value.channel.trim();
    if (ch && !CHANNEL_RE.test(ch)) return setError("Use the channel id (like C0123ABCD), not its name.");
    if (token.trim() && !token.trim().startsWith("xoxb-")) return setError("Use the app's bot token, which starts with xoxb-.");
    const tid = value.tenant.trim();
    if (tid && !GUID_RE.test(tid)) return setError("The Microsoft 365 tenant id is a GUID like 00000000-0000-0000-0000-000000000000.");
    const input: ApprovalSettingsInput = { slackChannel: ch, chatApprovalMaxRisk: value.maxRisk, escalationNotices: value.notices };
    // Sent only when changed, so saving other settings doesn't write them.
    if (dm !== null) input.dmApprovers = dm;
    if (reminder !== null) input.reminderMinutes = reminder;
    if (s?.teamsAvailable) input.mspTenantId = tid;
    if (token.trim()) input.slackBotToken = token.trim();
    if (await run("save", async () => (await api.updateApprovalSettings(input), "Chat approval settings saved."))) {
      setToken("");
      setChannel(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Approve from Slack and Teams"
      size="wide"
      footer={
        s && (
          <>
            {s.slackConnected && s.slackChannel && (
              <button className="btn" type="button" onClick={() => void run("test", async () => `Test message sent to ${(await api.testApprovals()).channel}.`)} disabled={busy !== null}>
                <Send className="icon-sm" aria-hidden="true" /> {busy === "test" ? "Sending…" : "Send test message"}
              </button>
            )}
            <span className="spacer" />
            <button className="btn" type="button" onClick={close} disabled={busy !== null}>
              Close
            </button>
            <button className="btn btn-primary" type="submit" form="chat-approvals-form" disabled={busy !== null}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </>
        )
      }
    >
      {settings.error && !s ? (
        <ErrorBanner error={settings.error} onRetry={settings.reload} />
      ) : !s ? (
        <Loading />
      ) : (
        <form id="chat-approvals-form" className="stack" onSubmit={save}>
          <p className="secondary" style={{ margin: 0 }}>
            Haley posts each approval to your team's channel with the change, why it needs approval and what she checked. Technicians in the{" "}
            <Link to="/technicians">directory</Link> can approve, reject or ask for changes right from the card, and every card updates when it's
            decided anywhere.
          </p>

          <section className="settings-group" aria-labelledby="ca-slack">
            <h3 id="ca-slack" className="settings-legend row" style={{ gap: 8 }}>
              Slack {s.slackConnected ? <Pill tone="green">Connected</Pill> : <Pill>Not connected</Pill>}
            </h3>
            {!s.slackAvailable ? (
              <p className="help" style={{ margin: 0 }}>
                Set <code>HALEY_SLACK_SIGNING_SECRET</code> on the Haley server first (the same Slack app clients use), so Haley can verify button clicks.
              </p>
            ) : (
              <>
                <Disclosure summary="Set up (once)">
                  <ol className="steps">
                    <li>
                      In your Haley Slack app at api.slack.com/apps, open <strong>Interactivity &amp; Shortcuts</strong>, turn it on, and set the Request URL to{" "}
                      <code>{s.interactivityUrl}</code> <CopyButton value={s.interactivityUrl} />
                    </li>
                    <li>Install the app in your own (MSP) workspace and paste its bot token below.</li>
                    <li>
                      Create or pick a channel for approvals, invite the app (<code>/invite @Haley</code>), and paste the channel id: open the channel details;
                      the id (C…) is at the bottom.
                    </li>
                  </ol>
                </Disclosure>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="ca-token">Bot token</label>
                    <input
                      id="ca-token"
                      className="input mono"
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder={s.slackConnected ? "Saved (paste a new one to replace)" : "xoxb-…"}
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="ca-channel">Approvals channel id</label>
                    <input id="ca-channel" className="input mono" value={value.channel} onChange={(e) => setChannel(e.target.value)} placeholder="C0123ABCD" spellCheck={false} />
                    <span className="help">Clients can use their own channel (client page, Self-service &amp; safety).</span>
                  </div>
                </div>
                {s.slackConnected && (
                  <div>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={busy !== null}
                      onClick={() => void run("disconnect", async () => (await api.updateApprovalSettings({ slackBotToken: null }), "Slack disconnected for approvals."))}
                    >
                      <Unplug className="icon-sm" aria-hidden="true" /> Disconnect Slack
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="settings-group" aria-labelledby="ca-teams">
            <h3 id="ca-teams" className="settings-legend row" style={{ gap: 8 }}>
              Microsoft Teams {s.teamsConversation ? <Pill tone="green">Connected</Pill> : <Pill>Not connected</Pill>}
            </h3>
            {!s.teamsAvailable ? (
              <p className="help" style={{ margin: 0 }}>
                Needs the Haley Teams bot (<code>HALEY_TEAMS_APP_ID</code> and <code>HALEY_TEAMS_APP_PASSWORD</code> on the server).
              </p>
            ) : (
              <div className="field">
                <label htmlFor="ca-tenant">Your Microsoft 365 tenant id</label>
                <input
                  id="ca-tenant"
                  className="input mono"
                  value={value.tenant}
                  onChange={(e) => setTenant(e.target.value)}
                  placeholder={s.teamsDefaultTenantId || "00000000-0000-0000-0000-000000000000"}
                  spellCheck={false}
                />
                <span className="help">Only people in this tenant can register a channel or decide from Teams cards.{s.teamsDefaultTenantId ? " Empty uses the bot's tenant." : ""}</span>
              </div>
            )}
            {!s.teamsAvailable ? null : s.teamsConversation ? (
              <div className="row row-wrap" style={{ gap: 8 }}>
                <span className="secondary">
                  Registered by {s.teamsConversation.registeredBy} on {new Date(s.teamsConversation.registeredAt).toLocaleDateString()}.
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy !== null}
                  onClick={() => void run("teams", async () => (await api.updateApprovalSettings({ teamsConversation: null }), "Teams approvals turned off."))}
                >
                  <Unplug className="icon-sm" aria-hidden="true" /> Stop posting to Teams
                </button>
              </div>
            ) : (
              <p className="help" style={{ margin: 0 }}>
                Add the Haley app to your team, then in the channel where approvals should go, post <code>@Haley approvals here</code>. Only technicians in the
                directory, signed in to your own Microsoft 365 tenant, can do this.
              </p>
            )}
          </section>

          <section className="settings-group" aria-labelledby="ca-rules">
            <h3 id="ca-rules" className="settings-legend">
              Rules
            </h3>
            <div className="field">
              <label htmlFor="ca-risk">What can be approved from chat</label>
              <select id="ca-risk" className="select" value={value.maxRisk} onChange={(e) => setMaxRisk(e.target.value as "write" | "destructive")}>
                <option value="destructive">Any change, including sensitive ones (password resets, sign-in blocks)</option>
                <option value="write">Routine changes only; sensitive ones are approved in the dashboard</option>
              </select>
              <span className="help">Client rules that name approvers apply in chat too, and hard rails can never be approved anywhere.</span>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <Switch id="ca-notices" checked={value.notices} onChange={setNotices} label="Post escalation notices" />
              <label htmlFor="ca-notices">Also post when Haley escalates a ticket to a person</label>
            </div>
            <div className="field">
              <div className="row" style={{ gap: 10 }}>
                <Switch id="ca-dm" checked={value.dm} onChange={setDm} label="Message named approvers directly" />
                <label htmlFor="ca-dm">Also send the card to named approvers directly</label>
              </div>
              <span className="help">
                When a client rule names who must approve, they get the card in a Slack DM or a Teams chat with the Haley bot. Teams needs the Haley app installed for
                each technician (a Teams admin can do that for everyone with an app setup policy).
              </span>
              {value.dm && s.approversWithoutChat.length > 0 && (
                <span className="help" style={{ color: "var(--tone-amber-fg)" }}>
                  Can't message {s.approversWithoutChat.join(", ")}: not in the <Link to="/technicians">directory</Link> or no linked Slack or Teams account yet.
                </span>
              )}
            </div>
            <div className="field">
              <label htmlFor="ca-reminder">Remind about waiting changes</label>
              <select id="ca-reminder" className="select" value={value.reminder} onChange={(e) => setReminder(Number(e.target.value) as ReminderMinutes)}>
                {REMINDERS.map(([m, label]) => (
                  <option key={m} value={m}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="help">Once per change: a reply under its card, and the card again to the approvers (or the ticket's technician).</span>
            </div>
          </section>

          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
