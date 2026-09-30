import { act } from "react";
import { describe, expect, it } from "vitest";
import { useDraft } from "../src/hooks/useDraft";
import { renderHook } from "./renderHook";

describe("server-backed form drafts", () => {
  it("updates an untouched form after discovery without marking it dirty", async () => {
    let saved = { domain: "before.example", protectedAccounts: ["admin@before.example"], maxAutoChangesPerHour: 10 };
    const hook = await renderHook(() => useDraft(saved));
    saved = { ...saved, domain: "after.example", protectedAccounts: [...saved.protectedAccounts, "discovered@after.example"] };
    await hook.rerender();
    expect(hook.result.draft).toEqual(saved);
    expect(hook.result.dirty).toBe(false);
    expect(hook.result.patch).toEqual({});
  });

  it("patches only edited fields while picking up unrelated server updates", async () => {
    let saved = { name: "Client", domain: "before.example", notes: "before" };
    const hook = await renderHook(() => useDraft(saved));
    await act(async () => hook.result.setDraft((d) => ({ ...d, notes: "local notes" })));
    saved = { ...saved, domain: "discovered.example" };
    await hook.rerender();
    expect(hook.result.draft.domain).toBe("discovered.example");
    expect(hook.result.patch).toEqual({ notes: "local notes" });
    saved = { ...saved, notes: "local notes" };
    await hook.rerender();
    expect(hook.result.dirty).toBe(false);
  });

  it("keeps newly discovered protected accounts when editing the same list", async () => {
    let saved = { protectedAccounts: ["keep@example.com", "remove@example.com"], limit: 10 };
    const hook = await renderHook(() => useDraft(saved));
    await act(async () => hook.result.setDraft((d) => ({ ...d, protectedAccounts: ["keep@example.com", "added@example.com"] })));
    saved = { ...saved, protectedAccounts: [...saved.protectedAccounts, "discovered@example.com"] };
    await hook.rerender();
    expect(hook.result.patch).toEqual({ protectedAccounts: ["keep@example.com", "discovered@example.com", "added@example.com"] });
    await act(async () => hook.result.reset());
    expect(hook.result.draft).toEqual(saved);
    expect(hook.result.dirty).toBe(false);
  });

  it("preserves server changes to other SLA targets during a local edit", async () => {
    let saved = { sla: { urgent: { response: 10, resolution: 60 }, normal: { response: 60, resolution: 240 } } };
    const hook = await renderHook(() => useDraft(saved));
    await act(async () => hook.result.setDraft((d) => ({ sla: { ...d.sla, urgent: { ...d.sla.urgent, response: 5 } } })));
    saved = { sla: { urgent: { response: 10, resolution: 45 }, normal: { response: 30, resolution: 240 } } };
    await hook.rerender();
    expect(hook.result.patch).toEqual({ sla: { urgent: { response: 5, resolution: 45 }, normal: { response: 30, resolution: 240 } } });
  });
});
