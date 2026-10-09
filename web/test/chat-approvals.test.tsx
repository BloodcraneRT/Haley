import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Action, type ApprovalSettingsView } from "../src/api";
import { ApprovalCard } from "../src/components/ApprovalCard";
import { ChatApprovalsModal } from "../src/components/ChatApprovals";
import { renderView } from "./renderHook";

vi.mock("../src/lib/app-context", () => ({
  useApp: () => ({ toast: vi.fn(), refreshStats: vi.fn(), user: "Dana Reyes" }),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});

async function click(node: Element) {
  await act(async () => (node as HTMLElement).click());
}

async function change(node: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

const button = (node: Element, text: string) => [...node.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

const action: Action = {
  id: "act_1", run_id: "run_1", org_id: "org_1", tool_use_id: "t1", tool: "m365_reset_password", input: {}, risk: "destructive",
  description: "Reset password for isaiah@contoso.example", rationale: "", policy_reason: "Supervised", approvers: [], status: "pending_approval",
  result: null, has_secrets: false, decided_by: null, decision_note: null, decided_at: null, executed_at: null, created_at: "2026-10-08T00:00:00Z",
};

const settings: ApprovalSettingsView = {
  slackChannel: "", slackTeamId: "", teamsConversation: null, chatApprovalMaxRisk: "destructive", escalationNotices: true, dmApprovers: true, reminderMinutes: 0,
  approversWithoutChat: [], mspTenantId: "", teamsDefaultTenantId: "",
  slackConnected: false, slackAvailable: true, teamsAvailable: false, interactivityUrl: "https://haley.msp.example/hooks/slack/interactivity",
};

describe("ask for changes", () => {
  it("needs a note before sending the change back to Haley", async () => {
    const send = vi.spyOn(api, "requestChanges").mockResolvedValue({ ...action, status: "changes_requested" });
    const { node } = await renderView(() => <MemoryRouter><ApprovalCard action={action} /></MemoryRouter>);
    await click(button(node, "Ask for changes"));
    expect(send).not.toHaveBeenCalled();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Say what should change");
    await change(node.querySelector<HTMLInputElement>("#note-act_1")!, "Use the manager's request");
    await click(button(node, "Ask for changes"));
    expect(send).toHaveBeenCalledWith("act_1", "Use the manager's request");
  });
});

describe("chat approval settings", () => {
  it("shows the Slack setup, validates the channel id, and saves the token without echoing it", async () => {
    vi.spyOn(api, "approvalSettings").mockResolvedValue(settings);
    const save = vi.spyOn(api, "updateApprovalSettings").mockResolvedValue({ ...settings, slackConnected: true, slackChannel: "C0APPROV" });
    const { node } = await renderView(() => <MemoryRouter><ChatApprovalsModal open onClose={() => undefined} /></MemoryRouter>);
    expect(node.textContent).toContain("https://haley.msp.example/hooks/slack/interactivity");
    expect(node.textContent).toContain("Needs the Haley Teams bot");

    await change(node.querySelector<HTMLInputElement>("#ca-token")!, "xoxb-1-secret");
    await change(node.querySelector<HTMLInputElement>("#ca-channel")!, "#approvals");
    const form = node.querySelector("#chat-approvals-form")!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(save).not.toHaveBeenCalled();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("channel id");

    await change(node.querySelector<HTMLInputElement>("#ca-channel")!, "C0APPROV");
    await change(node.querySelector<HTMLSelectElement>("#ca-risk")!, "write");
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(save).toHaveBeenCalledWith({ slackBotToken: "xoxb-1-secret", slackChannel: "C0APPROV", chatApprovalMaxRisk: "write", escalationNotices: true });
    expect(node.querySelector<HTMLInputElement>("#ca-token")!.value).toBe("");
  });

  it("asks for the MSP's tenant when the Teams bot is set up, and shows the registered channel", async () => {
    const registered = { ...settings, teamsAvailable: true, teamsDefaultTenantId: "aaaaaaaa-0000-0000-0000-000000000001",
      teamsConversation: { serviceUrl: "https://smba", conversationId: "19:x", tenantId: "t", registeredBy: "Dana Reyes", registeredAt: "2026-10-08T00:00:00Z" } };
    vi.spyOn(api, "approvalSettings").mockResolvedValue(registered);
    const save = vi.spyOn(api, "updateApprovalSettings").mockResolvedValue(registered);
    const { node } = await renderView(() => <MemoryRouter><ChatApprovalsModal open onClose={() => undefined} /></MemoryRouter>);
    expect(node.textContent).toContain("Registered by Dana Reyes");
    expect(node.querySelector<HTMLInputElement>("#ca-tenant")!.placeholder).toBe("aaaaaaaa-0000-0000-0000-000000000001");
    const form = node.querySelector("#chat-approvals-form")!;
    await change(node.querySelector<HTMLInputElement>("#ca-tenant")!, "contoso");
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(save).not.toHaveBeenCalled();
    await change(node.querySelector<HTMLInputElement>("#ca-tenant")!, "cccccccc-0000-0000-0000-000000000003");
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ mspTenantId: "cccccccc-0000-0000-0000-000000000003" }));
  });

  it("explains the missing signing secret instead of showing Slack fields", async () => {
    vi.spyOn(api, "approvalSettings").mockResolvedValue({ ...settings, slackAvailable: false });
    const { node } = await renderView(() => <MemoryRouter><ChatApprovalsModal open onClose={() => undefined} /></MemoryRouter>);
    expect(node.textContent).toContain("HALEY_SLACK_SIGNING_SECRET");
    expect(node.querySelector("#ca-token")).toBeNull();
  });

  it("turns on reminders, sends only what changed, and names approvers who can't be messaged", async () => {
    vi.spyOn(api, "approvalSettings").mockResolvedValue({ ...settings, approversWithoutChat: ["Priya Patel"] });
    const save = vi.spyOn(api, "updateApprovalSettings").mockResolvedValue(settings);
    const { node } = await renderView(() => <MemoryRouter><ChatApprovalsModal open onClose={() => undefined} /></MemoryRouter>);
    expect(node.textContent).toContain("Can't message Priya Patel");
    await change(node.querySelector<HTMLSelectElement>("#ca-reminder")!, "30");
    await act(async () => { node.querySelector("#chat-approvals-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(save).toHaveBeenCalledWith({ slackChannel: "", chatApprovalMaxRisk: "destructive", escalationNotices: true, reminderMinutes: 30 });
    await click(node.querySelector('[role="switch"][aria-label="Message named approvers directly"]')!);
    expect(node.textContent).not.toContain("Can't message Priya Patel");
  });
});
