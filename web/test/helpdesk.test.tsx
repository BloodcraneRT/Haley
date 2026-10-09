import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type HelpdeskSettings, type QaResult } from "../src/api";
import { CloseCheckModal } from "../src/components/CloseCheck";
import { TeamSettingsCard } from "../src/components/TeamSettings";
import { renderView } from "./renderHook";

vi.mock("../src/lib/app-context", () => ({ useApp: () => ({ toast: vi.fn() }) }));

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});

async function change(node: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

const check = (mode: QaResult["mode"]): QaResult => ({
  mode,
  modelChecked: false,
  issues: [
    { code: "no_reply", level: "warning", text: "Megan hasn't had a reply since their last message." },
    { code: "unkept_promise", level: "hint", text: "The last reply promised a follow-up." },
  ],
});

const submit = () => document.querySelector("#close-check-form")!;

describe("before you close", () => {
  it("lists what's missing and closes anyway without a reason in warn mode", async () => {
    const closeAnyway = vi.fn();
    const { node } = await renderView(() => <CloseCheckModal check={check("warn")} statusLabel="Resolved" busy={false} onClose={() => undefined} onCloseAnyway={closeAnyway} onReply={() => undefined} />);
    expect(node.textContent).toContain("Megan hasn't had a reply");
    expect(node.textContent).toContain("Reason to close anyway (optional)");
    await act(async () => { submit().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(closeAnyway).toHaveBeenCalledWith("");
  });

  it("requires a reason in require mode", async () => {
    const closeAnyway = vi.fn();
    const { node } = await renderView(() => <CloseCheckModal check={check("require")} statusLabel="Closed" busy={false} onClose={() => undefined} onCloseAnyway={closeAnyway} onReply={() => undefined} />);
    const button = node.querySelector<HTMLButtonElement>('button[form="close-check-form"]')!;
    expect(button.textContent).toBe("Mark closed anyway");
    expect(button.disabled).toBe(true);
    await change(node.querySelector<HTMLInputElement>("#close-check-reason")!, "Answered by phone");
    expect(button.disabled).toBe(false);
    await act(async () => { submit().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(closeAnyway).toHaveBeenCalledWith("Answered by phone");
  });
});

describe("team settings", () => {
  it("saves each change straight away", async () => {
    const settings: HelpdeskSettings = { qaBeforeClose: "warn", qaModelCheck: false, sentimentModelCheck: false, autoAssignOnEscalation: "off" };
    vi.spyOn(api, "helpdeskSettings").mockResolvedValue(settings);
    const save = vi.spyOn(api, "updateHelpdeskSettings").mockResolvedValue({ ...settings, qaBeforeClose: "require" });
    const { node } = await renderView(() => <TeamSettingsCard />);
    await change(node.querySelector<HTMLSelectElement>("#ts-qa")!, "require");
    expect(save).toHaveBeenCalledWith({ qaBeforeClose: "require" });
    await act(async () => node.querySelector<HTMLButtonElement>("#ts-sentiment")!.click());
    expect(save).toHaveBeenCalledWith({ sentimentModelCheck: true });
  });
});

describe("needs-care badges", () => {
  it("shows VIP and frustrated, with why on hover", async () => {
    const { CareBadges } = await import("../src/components/Pill");
    const { node } = await renderView(() => <CareBadges ticket={{ flags: { vip: true, frustrated: { reason: "strong language", confirmed: true } } }} />);
    expect(node.textContent).toBe("VIPFrustrated");
    expect(node.querySelector('[title^="Seems frustrated"]')!.getAttribute("title")).toBe("Seems frustrated: strong language (confirmed by the AI check)");
    const none = await renderView(() => <CareBadges ticket={{ flags: {} }} />);
    expect(none.node.textContent).toBe("");
  });
});

describe("rules suggested by Haley", () => {
  it("adds, edits first, or dismisses a suggestion, and marks rules that loosen policy", async () => {
    const { MemoryRouter } = await import("react-router-dom");
    const { PolicyRulesSection } = await import("../src/components/PolicyRules");
    const suggestion = {
      id: "rsug_1", org_id: "org_1", why: "Dana approves every reset.", ticket_id: "tkt_1", run_id: null, status: "pending" as const, decided_by: null, created_at: "2026-10-08T00:00:00Z",
      rule: { name: "Resets need Dana", enabled: true, tools: ["m365_reset_password"], risks: [], targets: [], departments: [], requesters: [], effect: "approve" as const, approvers: ["Dana Reyes"], minAssurance: "directory" as const },
    };
    const loosen = { ...suggestion, id: "rsug_2", rule: { ...suggestion.rule, name: "Let licences through", effect: "allow" as const } };
    vi.spyOn(api, "ruleSuggestions").mockResolvedValue([suggestion, loosen]);
    vi.spyOn(api, "technicians").mockResolvedValue({ technicians: [], suggestions: [] });
    const accept = vi.spyOn(api, "acceptRuleSuggestion").mockResolvedValue({ rule: { ...suggestion.rule, id: "rule_1" } });
    const dismiss = vi.spyOn(api, "dismissRuleSuggestion").mockResolvedValue({ ok: true });
    const org = { id: "org_1", name: "Contoso", integrations: [], settings: { policyRules: [] } } as never;
    const { node } = await renderView(() => <MemoryRouter><PolicyRulesSection org={org} onSaved={() => undefined} /></MemoryRouter>);
    const rows = [...node.querySelectorAll(".rule-suggestions li")];
    expect(rows[0].textContent).toContain("Resets need Dana");
    expect(rows[0].textContent).not.toContain("Loosens policy");
    expect(rows[1].textContent).toContain("Loosens policy");

    const buttonIn = (row: Element, label: string) => [...row.querySelectorAll("button")].find((b) => b.textContent === label)!;
    await act(async () => buttonIn(rows[0], "Add rule").click());
    expect(accept).toHaveBeenCalledWith("rsug_1");
    await act(async () => buttonIn(rows[1], "Dismiss").click());
    expect(dismiss).toHaveBeenCalledWith("rsug_2");
    await act(async () => buttonIn(rows[0], "Edit first").click());
    expect(node.querySelector<HTMLInputElement>("#rule-name")!.value).toBe("Resets need Dana");
  });
});
