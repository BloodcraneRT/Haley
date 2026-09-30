import { Brain, Check, Pencil, Plus, Trash } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage, type ClientMemory } from "../api";
import { usePoll } from "../hooks/usePoll";
import { useApp } from "../lib/app-context";
import { EmptyState, Spinner } from "./Feedback";
import { ConfirmModal, Modal } from "./Modal";
import { Pill } from "./Pill";
import { RelativeTime } from "./RelativeTime";

const MAX = 400;

/**
 * What Haley remembers about this client. Notes she saved from an end user's ticket wait here until a
 * technician confirms them; confirmed notes are shown to her on every run for this client.
 */
export function ClientMemorySection({ orgId }: { orgId: string }) {
  const { toast } = useApp();
  const memories = usePoll(() => api.memories(orgId), [orgId]);
  const [editing, setEditing] = useState<ClientMemory | "new" | null>(null);
  const [deleting, setDeleting] = useState<ClientMemory | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const all = memories.data ?? [];
  const pending = all.filter((m) => m.status === "pending");
  const active = all.filter((m) => m.status === "active");

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
      void memories.reload();
    }
  };

  const row = (m: ClientMemory) => (
    <li key={m.id} className="memory-row">
      <div className="memory-main">
        <p className="memory-content">{m.content}</p>
        <p className="memory-meta secondary">
          {m.source === "technician" ? `Added by ${m.created_by}` : "Learned by Haley"}
          {m.ticket_id && (
            <>
              {" "}
              on <Link to={`/tickets/${m.ticket_id}`}>a ticket</Link>
            </>
          )}
          {m.run_id && !m.ticket_id && (
            <>
              {" "}
              in <Link to={`/runs/${m.run_id}`}>a task</Link>
            </>
          )}
          {" · "}
          <RelativeTime iso={m.updated_at} />
          {m.reviewed_by && m.status === "active" && m.source === "agent" && ` · confirmed by ${m.reviewed_by}`}
        </p>
      </div>
      <div className="memory-actions">
        {m.status === "pending" && (
          <button
            className="btn btn-sm btn-primary"
            disabled={busy !== null}
            onClick={() => void act(m.id, () => api.updateMemory(m.id, { status: "active" }), "Confirmed. Haley will use this note.")}
          >
            <Check className="icon-sm" aria-hidden="true" /> Confirm
          </button>
        )}
        <button className="btn btn-sm btn-ghost btn-icon" disabled={busy !== null} onClick={() => setEditing(m)} aria-label="Edit note" title="Edit">
          <Pencil className="icon-sm" aria-hidden="true" />
        </button>
        <button
          className="btn btn-sm btn-ghost btn-icon"
          disabled={busy !== null}
          onClick={() => setDeleting(m)}
          aria-label={m.status === "pending" ? "Discard note" : "Delete note"}
          title={m.status === "pending" ? "Discard" : "Delete"}
        >
          <Trash className="icon-sm" aria-hidden="true" />
        </button>
      </div>
    </li>
  );

  return (
    <section aria-labelledby="memory-title">
      <div className="section-title">
        <h2 id="memory-title">What Haley remembers</h2>
        {active.length > 0 && <span className="count">{active.length}</span>}
        {pending.length > 0 && <Pill tone="amber">{pending.length} to review</Pill>}
        {(busy || (memories.loading && !memories.data)) && <Spinner />}
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => setEditing("new")}>
          <Plus className="icon-sm" aria-hidden="true" /> Add note
        </button>
      </div>
      <div className="card">
        <p className="rules-intro secondary">
          Short facts about this client that Haley sees on every run: quirks, who approves what, fixes that keep coming back. Notes she picks up from an
          end user's ticket wait for a technician to confirm them.
        </p>
        {memories.error && !memories.data && <p className="memory-error">{errorMessage(memories.error)}</p>}
        {pending.length > 0 && (
          <>
            <h3 className="memory-heading">Waiting for review</h3>
            <ul className="list memory-list is-pending">{pending.map(row)}</ul>
          </>
        )}
        {active.length > 0 ? (
          <>
            {pending.length > 0 && <h3 className="memory-heading">In use</h3>}
            <ul className="list memory-list">{active.map(row)}</ul>
          </>
        ) : (
          memories.data &&
          pending.length === 0 && (
            <EmptyState icon={<Brain className="icon" />} title="Nothing yet" compact>
              Haley adds notes as she works, or add one yourself, e.g. "Printers are on the 10.0.20.0/24 VLAN."
            </EmptyState>
          )
        )}
      </div>

      <MemoryModal
        memory={editing}
        busy={busy === "modal"}
        onClose={() => setEditing(null)}
        onSave={async (content, confirm) => {
          const target = editing;
          const ok = await act(
            "modal",
            () =>
              target === "new" || !target
                ? api.addMemory(orgId, content)
                : api.updateMemory(target.id, { content, ...(confirm ? { status: "active" as const } : {}) }),
            target === "new" ? "Note added." : confirm ? "Edited and confirmed." : "Note saved.",
          );
          if (ok) setEditing(null);
        }}
      />
      <ConfirmModal
        open={deleting !== null}
        title={deleting?.status === "pending" ? "Discard this note?" : "Delete this note?"}
        confirmLabel={deleting?.status === "pending" ? "Discard" : "Delete"}
        busy={busy === deleting?.id}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const target = deleting;
          const ok = await act(target.id, () => api.deleteMemory(target.id), target.status === "pending" ? "Discarded." : "Deleted.");
          if (ok) setDeleting(null);
        }}
      >
        {deleting?.status === "pending" ? "Haley won't use it." : "Haley stops seeing it on future runs."} “{deleting?.content}”
      </ConfirmModal>
    </section>
  );
}

function MemoryModal({
  memory,
  busy,
  onClose,
  onSave,
}: {
  memory: ClientMemory | "new" | null;
  busy: boolean;
  onClose: () => void;
  onSave: (content: string, confirm: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [lastKey, setLastKey] = useState<string | null>(null);
  const key = memory === "new" ? "new" : memory?.id ?? null;
  if (key !== lastKey) {
    setLastKey(key);
    setDraft(memory && memory !== "new" ? memory.content : "");
  }
  const pending = memory !== "new" && memory?.status === "pending";
  const trimmed = draft.trim();
  const valid = trimmed.length >= 3 && trimmed.length <= MAX;
  const submit = (e: FormEvent, confirm: boolean) => {
    e.preventDefault();
    if (valid) onSave(trimmed, confirm);
  };
  return (
    <Modal
      open={memory !== null}
      title={memory === "new" ? "Add a note" : pending ? "Review note" : "Edit note"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} type="button">
            Cancel
          </button>
          {pending ? (
            <>
              <button className="btn" type="submit" form="memory-form" disabled={!valid || busy}>
                Save for later
              </button>
              <button className="btn btn-primary" type="button" disabled={!valid || busy} onClick={(e) => submit(e, true)}>
                Save and confirm
              </button>
            </>
          ) : (
            <button className="btn btn-primary" type="submit" form="memory-form" disabled={!valid || busy}>
              {memory === "new" ? "Add note" : "Save"}
            </button>
          )}
        </>
      }
    >
      <form id="memory-form" className="stack-sm" onSubmit={(e) => submit(e, false)}>
        <div className="field">
          <label htmlFor="memory-note">Note</label>
          <textarea id="memory-note" className="input" rows={3} maxLength={MAX} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <p className="help">
            One or two sentences. Never passwords, codes or other secrets. {trimmed.length}/{MAX}
          </p>
        </div>
      </form>
    </Modal>
  );
}
