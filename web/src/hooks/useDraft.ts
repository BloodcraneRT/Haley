import { useEffect, useRef, useState } from "react";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Rebase local edits onto refreshed settings, keeping server additions to account lists. */
function rebase(draft: unknown, previous: unknown, saved: unknown): unknown {
  if (equal(draft, previous)) return saved;
  if (equal(saved, previous)) return draft;
  if (Array.isArray(draft) && Array.isArray(previous) && Array.isArray(saved)) {
    const removed = previous.filter((value) => !draft.includes(value));
    const added = draft.filter((value) => !previous.includes(value));
    return [...new Set([...saved.filter((value) => !removed.includes(value)), ...added])];
  }
  if (object(draft) && object(previous) && object(saved)) {
    return Object.fromEntries(Object.keys(saved).map((key) => [key, rebase(draft[key], previous[key], saved[key])]));
  }
  return draft;
}

/** Drafts track changes against the previous server value, not refreshed props. */
export function useDraft<T extends object>(saved: T) {
  const [draft, setDraft] = useState(saved);
  const previous = useRef(saved);
  useEffect(() => {
    const baseline = previous.current;
    previous.current = saved;
    setDraft((value) => rebase(value, baseline, saved) as T);
  }, [saved]);
  const patch = Object.fromEntries(
    (Object.keys(saved) as Array<keyof T>).filter((key) => !equal(draft[key], saved[key])).map((key) => [key, draft[key]]),
  ) as Partial<T>;
  return { draft, setDraft, patch, dirty: Object.keys(patch).length > 0, reset: () => setDraft(saved) };
}
