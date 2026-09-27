import { ArrowDownToLine, ArrowLeftRight, ArrowRight, ArrowUpFromLine, CircleCheck, CircleDashed, Hash, Mail, MessageCircle, MessagesSquare, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ASSURANCE_LEVELS, type Assurance, type ChannelInfo } from "../api";
import { CopyButton } from "../components/CopyButton";
import { CodeBlock, Disclosure } from "../components/Disclosure";
import { ErrorBanner, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { ProviderLogo } from "../components/ProviderLogo";
import { AssuranceBadge, IntegrationStatusPill, Pill } from "../components/Pill";
import { usePoll } from "../hooks/usePoll";
import { ASSURANCE_META } from "../lib/format";

const ICONS: Record<ChannelInfo["id"], typeof Mail> = { email: Mail, slack: Hash, teams: Users, chat: MessageCircle };

const EMAIL_SAMPLE = {
  from: "megan@contoso.com",
  fromName: "Megan Bowen",
  subject: "Locked out of Outlook",
  text: "Hi, I can't sign in since this morning…",
  messageId: "<CAF1234@mail.contoso.com>",
  inReplyTo: "<optional, for replies>",
  references: "<optional, for replies>",
  authenticationResults: "mx.example.net; spf=pass smtp.mailfrom=contoso.com; dkim=pass header.d=contoso.com; dmarc=pass header.from=contoso.com",
};

const CHAT_SAMPLE = {
  orgId: "optional: routes by the user's email domain when omitted",
  threadId: "conv-8841",
  user: { email: "megan@contoso.com", name: "Megan Bowen", verified: true, verification: "Signed in to the Contoso intranet widget" },
  text: "I'm locked out of my account",
  callbackUrl: "https://bridge.example.com/haley/replies",
  private: true,
};

const CALLBACK_SAMPLE = { threadId: "conv-8841", ticketNumber: 1042, text: "Hi Megan, I'm Haley from IT…", private: false };

function guidance(id: ChannelInfo["id"], url: string): ReactNode {
  switch (id) {
    case "slack":
      return (
        <ol className="steps">
          <li>
            <span>
              Create one Slack app for your MSP at <strong>api.slack.com/apps</strong>. Under <em>OAuth &amp; Permissions</em> add bot scopes{" "}
              <code>chat:write</code> <code>im:history</code> <code>app_mentions:read</code> <code>users:read</code> <code>users:read.email</code>.
            </span>
          </li>
          <li>
            <span>
              Under <em>Event Subscriptions</em> set the Request URL to the webhook above and subscribe to bot events <code>message.im</code> and{" "}
              <code>app_mention</code>. Under <em>App Home</em>, enable the Messages tab.
            </span>
          </li>
          <li>
            <span>
              Set <code>HALEY_SLACK_SIGNING_SECRET</code> on the server to the app's signing secret and restart.
            </span>
          </li>
          <li>
            <span>
              For each client, install the app in their workspace and connect it from the <Link to="/clients">client page</Link> with the{" "}
              <strong>Slack</strong> provider (bot token <code>xoxb-…</code>). Haley detects the workspace automatically.
            </span>
          </li>
        </ol>
      );
    case "teams":
      return (
        <ol className="steps">
          <li>
            <span>
              In the Azure portal create an <strong>Azure Bot</strong> registration (multi-tenant, or single-tenant for one client) and enable its
              Microsoft Teams channel.
            </span>
          </li>
          <li>
            <span>
              Set the bot's <em>messaging endpoint</em> to the webhook above.
            </span>
          </li>
          <li>
            <span>
              Set <code>HALEY_TEAMS_APP_ID</code> and <code>HALEY_TEAMS_APP_PASSWORD</code> (the bot's app ID and client secret), plus{" "}
              <code>HALEY_TEAMS_TENANT_ID</code> for a single-tenant registration, and restart.
            </span>
          </li>
          <li>
            <span>
              Map each client's tenant: a <strong>live Microsoft 365 integration</strong> maps it automatically and lets Haley match senders to their
              directory account (directory identity). Otherwise enter the <strong>Teams tenant ID</strong> in the client's Self-service &amp; safety
              settings.
            </span>
          </li>
          <li>
            <span>Publish the bot as a Teams app in each client's tenant (or sideload it) so employees can message Haley.</span>
          </li>
        </ol>
      );
    case "email":
      return (
        <>
          <ol className="steps">
            <li>
              <span>
                Point a mail-to-webhook service at the webhook above: <strong>SendGrid Inbound Parse</strong>, <strong>Mailgun</strong> routes,{" "}
                <strong>Postmark</strong> inbound or <strong>Cloudflare Email Workers</strong>. Authenticate with <code>?key=</code> or the{" "}
                <code>x-haley-hook-secret</code> header set to <code>HALEY_EMAIL_HOOK_SECRET</code>.
              </span>
            </li>
            <li>
              <span>
                Map the provider's payload to the JSON below. Always pass the receiving server's <code>Authentication-Results</code> header as{" "}
                <code>authenticationResults</code> (or <code>dmarc</code> / <code>dkim</code> / <code>spf</code> verdicts): without DMARC pass or an
                aligned DKIM signature the sender counts as unverified.
              </span>
            </li>
            <li>
              <span>
                Senders are routed to a client by their email domain: its primary domain plus any extra domains in the client's settings.
              </span>
            </li>
            <li>
              <span>
                For replies set <code>HALEY_SMTP_URL</code> (e.g. <code>smtps://user:pass@smtp.example.com:465</code>) and <code>HALEY_SMTP_FROM</code>.
                Subjects carry <code>[#1042]</code> so answers thread onto the same ticket.
              </span>
            </li>
          </ol>
          <Disclosure summary="Webhook body (JSON)">
            <CodeBlock value={EMAIL_SAMPLE} />
          </Disclosure>
        </>
      );
    case "chat":
      return (
        <>
          <ol className="steps">
            <li>
              <span>
                For anything without a native adapter: Google Chat, SMS, WhatsApp, a web widget. Set <code>HALEY_CHAT_WEBHOOK_SECRET</code> on the server.
              </span>
            </li>
            <li>
              <span>
                Sign every request: <code>x-haley-signature: sha256=&lt;hex&gt;</code>, the HMAC-SHA256 of the <em>raw</em> request body with the secret.
              </span>
            </li>
            <li>
              <span>
                Send <code>verified: true</code> only when the bridge authenticated the user (signed-in portal, verified phone); that gives a chat
                identity. Send <code>private: true</code> only if the bridge can show a message to that user alone, which is required before Haley
                sends credentials.
              </span>
            </li>
            <li>
              <span>
                Haley POSTs replies to <code>callbackUrl</code>, signed the same way; verify the signature before showing them.
              </span>
            </li>
          </ol>
          <Disclosure summary="Request body (JSON)">
            <CodeBlock value={CHAT_SAMPLE} />
          </Disclosure>
          <Disclosure summary="Signed callback Haley sends back">
            <CodeBlock value={CALLBACK_SAMPLE} />
          </Disclosure>
        </>
      );
  }
  return <span className="muted">{url}</span>;
}

function ChannelCard({ channel: c }: { channel: ChannelInfo }) {
  const Icon = ICONS[c.id] ?? MessageCircle;
  return (
    <article className="channel-card" aria-labelledby={`ch-${c.id}`}>
      <header className="channel-card-head">
        <span className={`channel-glyph ${c.enabled ? "is-on" : ""}`} aria-hidden="true">
          <Icon className="icon" />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 id={`ch-${c.id}`}>{c.name}</h2>
          <div className="row row-wrap" style={{ gap: 6, marginTop: 4 }}>
            {c.enabled ? (
              <Pill tone="green" dot>
                Enabled
              </Pill>
            ) : (
              <Pill tone="neutral" dot>
                Not configured
              </Pill>
            )}
            <span className={`flow ${c.inbound ? "on" : ""}`} title={c.inbound ? "Receives messages from end users" : "Inbound not configured"}>
              <ArrowDownToLine className="icon-xs" aria-hidden="true" /> Inbound {c.inbound ? "on" : "off"}
            </span>
            <span className={`flow ${c.outbound ? "on" : ""}`} title={c.outbound ? "Sends Haley's replies" : "Outbound not configured"}>
              <ArrowUpFromLine className="icon-xs" aria-hidden="true" /> Replies {c.outbound ? "on" : "off"}
            </span>
          </div>
        </div>
      </header>

      <div className="field">
        <span className="field-label">Webhook URL</span>
        <div className="copy-field">
          <code className="truncate" title={c.webhookUrl}>
            {c.webhookUrl}
          </code>
          <CopyButton value={c.webhookUrl} />
        </div>
        {c.webhookUrl.includes("key=…") && (
          <span className="help">
            Replace <code>…</code> with the value of <code>HALEY_EMAIL_HOOK_SECRET</code>, or send it in the <code>x-haley-hook-secret</code> header instead.
          </span>
        )}
      </div>

      <div className="field">
        <span className="field-label">Server environment</span>
        <div className="row row-wrap" style={{ gap: 6 }}>
          {c.env.map((e) => (
            <code key={e} className="env-var">
              {e}
            </code>
          ))}
        </div>
      </div>

      <Disclosure summary="Setup guide">
        <div className="stack-sm">{guidance(c.id, c.webhookUrl)}</div>
      </Disclosure>
    </article>
  );
}

type Can = "run" | "approve" | "limit";

const LADDER: Record<Assurance, { write: Can; sensitive: Can; approver: Can; approverNote?: string }> = {
  none: { write: "approve", sensitive: "approve", approver: "approve" },
  email: { write: "run", sensitive: "approve", approver: "run", approverNote: "except security-sensitive" },
  chat: { write: "run", sensitive: "limit", approver: "run" },
  directory: { write: "run", sensitive: "limit", approver: "run" },
  mfa: { write: "run", sensitive: "limit", approver: "run" },
  technician: { write: "run", sensitive: "run", approver: "run", approverNote: "technician authority" },
};

function Outcome({ can, note }: { can: Can; note?: string }) {
  return (
    <span className="ladder-cell">
      {can === "run" ? (
        <Pill tone="green">Automatic</Pill>
      ) : can === "limit" ? (
        <Pill tone="green" title="Up to the client's daily per-person limit">
          Automatic · daily limit
        </Pill>
      ) : (
        <Pill tone="amber">Approval</Pill>
      )}
      {note && <span className="muted">{note}</span>}
    </span>
  );
}

function PsaSources() {
  const psa = usePoll(() => api.psaConnections(), []);
  const list = psa.data ?? [];
  return (
    <section className="card psa-sources" aria-labelledby="psa-src-title">
      <div className="card-header">
        <ArrowLeftRight className="icon-sm" aria-hidden="true" />
        <h2 id="psa-src-title">Tickets from your PSA</h2>
        <span className="spacer" />
        <Link to="/psa" className="row" style={{ gap: 4, fontSize: "var(--text-sm)" }}>
          PSA sync <ArrowRight className="icon-sm" aria-hidden="true" />
        </Link>
      </div>
      <div className="card-body psa-sources-body">
        <p className="secondary" style={{ fontSize: "var(--text-sm)" }}>
          Customers who already email or call your service desk don't need a new channel. Connect <strong>SyncroMSP</strong> or{" "}
          <strong>Dynamics 365 Customer Service</strong> and their tickets reach Haley automatically; she replies as a public comment (Syncro emails
          the customer) or on the case timeline, and status stays in sync. These tickets show the PSA number, e.g. <em>Syncro #1234</em>.
        </p>
        <div className="row row-wrap" style={{ gap: 8 }}>
          {list.length === 0 ? (
            <>
              <span className="chip">
                <ProviderLogo provider="syncro" /> SyncroMSP
              </span>
              <span className="chip">
                <ProviderLogo provider="dynamics" /> Dynamics 365
              </span>
              <Link to="/psa?connect=1" className="btn btn-sm">
                Connect a PSA
              </Link>
            </>
          ) : (
            list.map((c) => (
              <Link key={c.id} to="/psa" className="chip psa-source-chip">
                <ProviderLogo provider={c.kind} /> {c.name} <IntegrationStatusPill status={c.status} />
              </Link>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

export function ChannelsPage() {
  const channels = usePoll(() => api.channels(), []);

  return (
    <>
      <PageHeader
        title="Channels"
        subtitle="How your clients' employees reach Haley directly. Each channel opens and threads tickets, sends Haley's replies back the same way, and tells her how sure she can be of who's asking."
        actions={
          <Link to="/simulate" className="btn btn-primary">
            <MessagesSquare className="icon-sm" aria-hidden="true" /> Try as an end user
          </Link>
        }
      />

      {channels.error && <ErrorBanner error={channels.error} onRetry={channels.reload} />}
      {!channels.data ? (
        !channels.error && <Loading />
      ) : (
        <div className="stack" style={{ gap: 28 }}>
          <div className="channel-grid">
            {channels.data.map((c) => (
              <ChannelCard key={c.id} channel={c} />
            ))}
          </div>

          <PsaSources />

          <section aria-labelledby="ladder-title" className="card">
            <div className="card-header">
              <h2 id="ladder-title">Identity assurance</h2>
              <span className="spacer" />
              <span className="muted hide-sm" style={{ fontSize: "var(--text-sm)" }}>
                What each level can do automatically under <strong>Unattended</strong>
              </span>
            </div>
            <div className="card-body stack-sm">
              <p className="secondary" style={{ fontSize: "var(--text-sm)" }}>
                Every ticket records how its requester was identified, from weakest to strongest. Haley's approval policy uses it: the stronger the
                identity, the more she'll do without a technician.
              </p>
              <div className="ladder-steps" aria-hidden="true">
                {ASSURANCE_LEVELS.map((a, i) => (
                  <span key={a} className="ladder-step">
                    <AssuranceBadge assurance={a} short />
                    {i < ASSURANCE_LEVELS.length - 1 && <ArrowRight className="icon-xs muted" />}
                  </span>
                ))}
              </div>
              <div className="table-wrap">
                <table className="policy-table ladder-table">
                  <thead>
                    <tr>
                      <th scope="col">Level</th>
                      <th scope="col">How it's established</th>
                      <th scope="col">Changes to own account</th>
                      <th scope="col">Password reset, sign-out, TAP (own account)</th>
                      <th scope="col">Authorized approver asking</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ASSURANCE_LEVELS.map((a) => (
                      <tr key={a}>
                        <th scope="row">
                          <AssuranceBadge assurance={a} />
                        </th>
                        <td className="secondary">{ASSURANCE_META[a].how}</td>
                        <td>
                          <Outcome can={LADDER[a].write} />
                        </td>
                        <td>
                          <Outcome can={LADDER[a].sensitive} />
                        </td>
                        <td>
                          <Outcome can={LADDER[a].approver} note={LADDER[a].approverNote} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="policy-notes">
                <li>
                  <CircleCheck className="icon-xs" aria-hidden="true" /> Access grants (groups, shared mailboxes, app access) always need an authorized
                  approver, whoever's account it is.
                </li>
                <li>
                  <CircleDashed className="icon-xs" aria-hidden="true" /> Protected accounts, the hourly change limit and anything the rules don't cover
                  fall back to the approval queue. Other autonomy levels ignore identity: Supervised asks for everything, Autonomous for
                  security-sensitive changes.
                </li>
              </ul>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
