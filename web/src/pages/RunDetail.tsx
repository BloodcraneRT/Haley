import { ArrowDown, BrainCircuit, ChevronRight, CircleAlert, ClipboardList, Coins, FileText, Play, Repeat, RotateCcw, ShieldCheck, Sparkles, Ticket as TicketIcon, User, Zap } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, errorMessage, type Action, type RunDetail, type RunMode, type TranscriptStep } from "../api";
import { ApprovalCard, PolicyReason } from "../components/ApprovalCard";
import { Avatar } from "../components/Avatar";
import { CodeBlock, Disclosure } from "../components/Disclosure";
import { EmptyState, ErrorBanner, Loading, Spinner } from "../components/Feedback";
import { Markdown } from "../components/Markdown";
import { PageHeader } from "../components/PageHeader";
import { ActionStatusPill, Pill, RiskPill, RunModeBadge, RunStatusPill } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { RevealSecretButton } from "../components/RevealSecret";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { formatNumber, formatTokens, formatUsd, isRunActive } from "../lib/format";

type ToolResult = Extract<TranscriptStep, { type: "tool_result" }>;

export function RunDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { toast, refreshStats } = useApp();
  const detail = usePoll(
    () => api.run(id),
    [id],
    (d) => (!d ? null : isRunActive(d.run.status) ? 2000 : d.run.status === "awaiting_approval" ? 10_000 : null),
  );
  const [retrying, setRetrying] = useState<RunMode | null>(null);

  if (detail.error instanceof ApiError && detail.error.status === 404) {
    return (
      <div className="card">
        <EmptyState title="Run not found" actions={<Link to="/runs" className="btn">All runs</Link>} />
      </div>
    );
  }
  if (!detail.data) return detail.error ? <ErrorBanner error={detail.error} onRetry={detail.reload} /> : <Loading />;

  const { run, actions, usage } = detail.data;
  const active = isRunActive(run.status);
  const pending = actions.filter((a) => a.status === "pending_approval");
  const done = run.status === "completed" || run.status === "failed";

  const plan = run.mode === "plan";

  const retry = async (mode: RunMode) => {
    setRetrying(mode);
    try {
      const next = run.ticket_id
        ? await api.runTicket(run.ticket_id, mode)
        : await api.startTask({ orgId: run.org_id, title: run.title, instruction: run.instruction, mode, ...(run.template_id ? { templateId: run.template_id } : {}) });
      toast(mode === "live" && plan ? "Running it for real." : "Started a new run.");
      refreshStats();
      navigate(`/runs/${next.id}`);
    } catch (err) {
      toast(errorMessage(err), err instanceof ApiError && err.status === 409 ? "info" : "error");
    } finally {
      setRetrying(null);
    }
  };

  return (
    <>
      {detail.error && <ErrorBanner error={`Refresh failed. Showing the last loaded run. ${detail.error.message}`} onRetry={detail.reload} />}
      <PageHeader
        docTitle={run.title}
        breadcrumb={
          <>
            <Link to="/runs">Runs</Link>
            <ChevronRight className="icon-sm" aria-hidden="true" />
            <Link to={`/clients/${run.org_id}`}>{run.org_name}</Link>
          </>
        }
        title={run.title}
        subtitle={
          <span className="row row-wrap" style={{ gap: 8 }}>
            <RunStatusPill status={run.status} />
            <RunModeBadge mode={run.mode} />
            <Pill tone="neutral">{run.kind === "ticket" ? "Ticket run" : "Task"}</Pill>
            <span>
              Started by {run.created_by} <RelativeTime iso={run.created_at} />
            </span>
          </span>
        }
        actions={
          <>
            {run.ticket_id && (
              <Link to={`/tickets/${run.ticket_id}`} className="btn">
                <TicketIcon className="icon-sm" aria-hidden="true" /> Open ticket
              </Link>
            )}
            {done && (
              <button className="btn" onClick={() => void retry(run.mode)} disabled={retrying !== null}>
                {retrying === run.mode ? <Spinner /> : run.status === "failed" ? <RotateCcw className="icon-sm" aria-hidden="true" /> : <Repeat className="icon-sm" aria-hidden="true" />}
                {run.status === "failed" ? "Try again" : plan ? "Plan again" : run.ticket_id ? "Follow-up run" : "Run again"}
              </button>
            )}
            {plan && run.status === "completed" && (
              <button className="btn btn-primary" onClick={() => void retry("live")} disabled={retrying !== null}>
                {retrying === "live" ? <Spinner /> : <Play className="icon-sm" aria-hidden="true" />} Run for real
              </button>
            )}
          </>
        }
      />

      <div className="statline" style={{ marginTop: -12, marginBottom: 20 }}>
        <span title="Model turns">
          <Sparkles className="icon-sm" aria-hidden="true" /> <strong>{run.iterations}</strong> turn{run.iterations === 1 ? "" : "s"}
        </span>
        <span title={`${formatNumber(run.input_tokens)} input · ${formatNumber(run.output_tokens)} output tokens`}>
          <Coins className="icon-sm" aria-hidden="true" /> <strong>{formatTokens(run.input_tokens)}</strong> in · <strong>{formatTokens(run.output_tokens)}</strong> out
        </span>
        {usage && usage.modelCalls > 0 && (
          <span
            title={
              usage.usd === null
                ? `No price set for ${usage.unpricedModels.join(", ")}. Add prices on the AI models page.`
                : "AI cost of this run at the prices on the AI models page"
            }
          >
            {usage.usd === null ? (
              <>cost not priced</>
            ) : (
              <>
                AI cost <strong>{formatUsd(usage.usd)}</strong>
              </>
            )}
          </span>
        )}
        <span>
          <Zap className="icon-sm" aria-hidden="true" /> <strong>{actions.length}</strong> tool call{actions.length === 1 ? "" : "s"}
        </span>
        {run.model && (
          <span title="The provider and model that served Haley's latest turn (a fallback model if the primary failed)">
            <BrainCircuit className="icon-sm" aria-hidden="true" /> served by <strong className="mono run-model-strong">{run.model}</strong>
          </span>
        )}
        <span>
          <User className="icon-sm" aria-hidden="true" /> {run.created_by}
        </span>
        <span>
          Updated <RelativeTime iso={run.updated_at} />
        </span>
      </div>

      <div className="stack" style={{ gap: 20 }}>
        {plan && (
          <div className="banner banner-plan" role="note">
            <ClipboardList className="icon" aria-hidden="true" />
            <span className="spacer">
              <strong>Plan (dry run).</strong> Haley investigated with read-only tools and simulated every change. Steps marked{" "}
              <em>Planned – not executed</em> show what she would do and whether the live policy would run them automatically or ask for approval.
              {run.ticket_id ? " The requester wasn't contacted." : ""}
            </span>
            {run.status === "completed" && (
              <button className="btn btn-primary btn-sm" onClick={() => void retry("live")} disabled={retrying !== null}>
                {retrying === "live" ? <Spinner /> : <Play className="icon-sm" aria-hidden="true" />} Run for real
              </button>
            )}
          </div>
        )}

        {run.status === "failed" && (
          <div className="banner banner-error" role="alert">
            <CircleAlert className="icon" aria-hidden="true" />
            <span>
              <strong>This run failed.</strong> {run.error || "No error message was recorded."}
            </span>
          </div>
        )}

        {pending.length > 0 && (
          <div className="banner banner-warn" role="status">
            <ShieldCheck className="icon" aria-hidden="true" />
            <span className="spacer">
              <strong>Haley is paused</strong> waiting on {pending.length} approval{pending.length === 1 ? "" : "s"}. She continues once every pending action is
              decided.
            </span>
            <a href={`#action-${pending[0].id}`} className="row nowrap" style={{ gap: 4 }}>
              Jump to it <ArrowDown className="icon-sm" aria-hidden="true" />
            </a>
          </div>
        )}

        {run.status === "completed" && run.summary.trim() && (
          <section className="card" aria-labelledby="summary-title">
            <div className="card-header">
              <Sparkles className="icon-sm" style={{ color: "var(--tone-violet-fg)" }} aria-hidden="true" />
              <h2 id="summary-title">{plan ? "The plan" : "Summary"}</h2>
            </div>
            <div className="card-body">
              <Markdown source={run.summary} />
            </div>
          </section>
        )}

        {run.kind === "task" && run.instruction && (
          <section className="card card-pad" aria-labelledby="instr-title">
            <h2 id="instr-title" className="row" style={{ fontSize: "var(--text-md)", marginBottom: 8, gap: 6 }}>
              <FileText className="icon-sm" aria-hidden="true" /> Instruction
            </h2>
            <div className="pre-wrap secondary">{run.instruction}</div>
          </section>
        )}

        <section aria-labelledby="activity-title">
          <div className="section-title">
            <h2 id="activity-title">Activity</h2>
            {active && (
              <span className="row muted" style={{ fontSize: "var(--text-sm)", gap: 6 }}>
                <Spinner /> live
              </span>
            )}
          </div>
          <Transcript detail={detail.data} onDecided={() => void detail.reload()} />
        </section>
      </div>
    </>
  );
}

function Transcript({ detail, onDecided }: { detail: RunDetail; onDecided: () => void }) {
  const { run, transcript, actions } = detail;
  const results = new Map<string, ToolResult>();
  const calls = new Set<string>();
  for (const s of transcript) {
    if (s.type === "tool_result") results.set(s.toolUseId, s);
    if (s.type === "tool_call") calls.add(s.toolUseId);
  }
  const actionsByUse = new Map(actions.map((a) => [a.tool_use_id, a]));
  const active = isRunActive(run.status);

  if (transcript.length === 0) {
    return (
      <div className="card">
        {active ? <Loading label="Haley is getting started…" /> : <EmptyState title="No activity recorded" compact />}
      </div>
    );
  }

  return (
    <ol className="feed">
      {transcript.map((step, n) => {
        switch (step.type) {
          case "context":
            return (
              <li key={n} className="context-card">
                <Disclosure summary="Context Haley was given">
                  <div className="pre-wrap mono" style={{ fontSize: 12, color: "var(--text-2)" }}>
                    {step.text}
                  </div>
                </Disclosure>
              </li>
            );
          case "text":
            return (
              <li key={n} className="feed-message">
                <Avatar name="haley" large />
                <div className="feed-bubble haley">
                  <Markdown source={step.text} />
                </div>
              </li>
            );
          case "tool_call":
            return (
              <ToolCall
                key={n}
                tool={step.tool}
                input={step.input}
                action={actionsByUse.get(step.toolUseId) ?? step.action}
                result={results.get(step.toolUseId)}
                onDecided={onDecided}
              />
            );
          case "tool_result":
            // Rendered with its call; show orphans so nothing is hidden.
            return calls.has(step.toolUseId) ? null : (
              <li key={n} className={`feed-tool ${step.isError ? "is-error" : ""}`}>
                <div className="feed-tool-details" style={{ paddingTop: 8 }}>
                  <Disclosure summary={step.isError ? "Error result" : "Result"}>
                    <CodeBlock value={step.content} error={step.isError} />
                  </Disclosure>
                </div>
              </li>
            );
        }
      })}
      {active && (
        <li className="feed-message" aria-live="polite">
          <Avatar name="haley" large />
          <div className="row muted" style={{ gap: 8 }}>
            <Spinner /> Haley is working…
          </div>
        </li>
      )}
    </ol>
  );
}

function ToolCall({
  tool,
  input,
  action,
  result,
  onDecided,
}: {
  tool: string;
  input: unknown;
  action: Action | null;
  result: ToolResult | undefined;
  onDecided: () => void;
}) {
  const isError = result?.isError || action?.status === "failed";
  const pending = action?.status === "pending_approval";
  const planned = action?.status === "planned";
  const live = planned ? liveOutcome(action?.result) : null;
  return (
    <li
      id={action ? `action-${action.id}` : undefined}
      className={`feed-tool ${isError ? "is-error" : ""} ${pending ? "is-pending" : ""} ${planned ? "is-planned" : ""}`}
    >
      <div className="feed-tool-row">
        <span className="tool-name">{tool}</span>
        <span className="desc truncate" title={action?.description}>
          {action?.description && action.description !== tool ? action.description : ""}
        </span>
        {action && <RiskPill risk={action.risk} />}
        {action ? (
          <ActionStatusPill status={action.status} />
        ) : result ? (
          <Pill tone={result.isError ? "red" : "neutral"} dot>
            {result.isError ? "Error" : "Done"}
          </Pill>
        ) : null}
      </div>
      {live && <div className="planned-note">{live}</div>}
      {action?.policy_reason?.trim() && (action.status === "pending_approval" || action.status === "blocked" || action.decided_by || planned) && (
        <div style={{ padding: "0 10px 8px" }}>
          <PolicyReason
            reason={action.policy_reason}
            compact
            label={action.status === "blocked" ? "Why it was blocked" : planned ? "Live policy" : "Why this needs approval"}
          />
        </div>
      )}
      {action?.decided_by && action.decided_by !== "system" && (action.status === "executed" || action.status === "rejected" || action.status === "changes_requested" || action.status === "failed" || action.status === "approved") && (
        <div className="muted" style={{ padding: "0 10px 6px", fontSize: "var(--text-sm)" }}>
          {action.status === "rejected" ? "Rejected" : action.status === "changes_requested" ? "Changes requested" : "Approved"} by {action.decided_by}
          {action.decision_note ? `: “${action.decision_note}”` : ""}
        </div>
      )}
      <div className="feed-tool-details">
        <Disclosure summary="Input">
          <CodeBlock value={input} />
        </Disclosure>
        {result && (
          <Disclosure summary={result.isError ? <span style={{ color: "var(--tone-red-fg)" }}>Error</span> : "Result"} defaultOpen={result.isError}>
            <CodeBlock value={result.content} error={result.isError} />
          </Disclosure>
        )}
        {action?.has_secrets && (
          <div style={{ flexBasis: "100%" }}>
            <RevealSecretButton actionId={action.id} />
          </div>
        )}
      </div>
      {pending && action && <ApprovalCard action={action} minimal compact onDecided={onDecided} />}
    </li>
  );
}

/** Plan runs store { planned: true, live: "run" | "approve" | "block" }: what the live policy would have done. */
function liveOutcome(result: unknown): string | null {
  const live = result && typeof result === "object" ? (result as { live?: unknown }).live : undefined;
  if (live === "run") return "In a live run this step would run automatically.";
  if (live === "approve") return "In a live run this step would wait for a technician's approval.";
  if (live === "block") return "In a live run this step would be blocked by the client's policy.";
  return "Not executed: this is a dry run.";
}
