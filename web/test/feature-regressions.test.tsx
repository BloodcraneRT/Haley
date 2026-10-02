import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type ClientMemory, type ModelProfileListItem, type ModelProviderPreset, type OrgSummary, type TaskTemplate, type UsageReport } from "../src/api";
import { ClientMemorySection } from "../src/components/ClientMemory";
import { ModelsPage } from "../src/pages/Models";
import { TasksPage } from "../src/pages/Tasks";
import { UsagePage } from "../src/pages/Usage";
import { deferred, renderView } from "./renderHook";

vi.mock("../src/lib/app-context", () => ({
  useApp: () => ({ toast: vi.fn(), refreshStats: vi.fn(), refreshHealth: vi.fn(), health: { aiConfigured: true } }),
  aiReady: () => true,
}));

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});

async function click(node: Element) {
  await act(async () => (node as HTMLElement).click());
}

async function change(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

async function submit(form: Element) {
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

const orgs = [{ id: "first", name: "First client", settings: {} }, { id: "second", name: "Second client", settings: {} }] as OrgSummary[];
const recipe: TaskTemplate = {
  id: "offboard", name: "Offboard user", description: "Remove access", instruction: "User: example@example.com", category: "Identity & access",
  requires: [["m365"]], tools: [], changes: true, estimatedMinutes: 30, tags: [], available: true, missing: [],
};
const memory: ClientMemory = {
  id: "note-first", org_id: "first", content: "Printers use VLAN 20", status: "active", source: "technician", run_id: null,
  ticket_id: null, created_by: "Tech", reviewed_by: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

describe("recipe availability", () => {
  it("blocks a selected recipe while the new client's availability is loading or failed, and offers retry", async () => {
    const pending = deferred<TaskTemplate[]>();
    vi.spyOn(api, "orgs").mockResolvedValue(orgs);
    vi.spyOn(api, "runs").mockResolvedValue([]);
    const templates = vi.spyOn(api, "templates").mockImplementation((orgId) => orgId === "second" ? pending.promise : Promise.resolve([recipe]));
    const start = vi.spyOn(api, "startTask");
    const { node } = await renderView(() => <MemoryRouter initialEntries={["/tasks?orgId=first"]}><TasksPage /></MemoryRouter>);
    await click(node.querySelector(".recipe")!);
    await change(node.querySelector<HTMLSelectElement>("#task-org")!, "second");
    expect(node.querySelector<HTMLButtonElement>(".recipe")!.disabled).toBe(true);
    expect(node.querySelector<HTMLButtonElement>("form button[type=submit]")!.disabled).toBe(true);
    await submit(node.querySelector("form")!);
    expect(start).not.toHaveBeenCalled();
    await act(async () => pending.reject(new Error("Availability unavailable")));
    expect(node.textContent).toContain("Availability unavailable");
    expect(node.textContent).toContain("Retry");
    templates.mockResolvedValue([{ ...recipe, available: false, missing: ["Microsoft 365"] }]);
    await click([...node.querySelectorAll("button")].find((b) => b.textContent?.includes("Retry"))!);
    expect(node.textContent).toContain("Second client doesn't have Microsoft 365 connected");
    expect(node.querySelector<HTMLButtonElement>("form button[type=submit]")!.disabled).toBe(true);
    await click(node.querySelector(".recipe-custom")!);
    expect(node.querySelector<HTMLButtonElement>("form button[type=submit]")!.disabled).toBe(false);
  });
});

describe("client memory editing", () => {
  it("closes the previous client's note editor on client navigation", async () => {
    vi.spyOn(api, "memories").mockImplementation((id) => Promise.resolve(id === "first" ? [memory] : []));
    let orgId = "first";
    const { node, rerender } = await renderView(() => <MemoryRouter><ClientMemorySection orgId={orgId} /></MemoryRouter>);
    await click(node.querySelector('[aria-label="Edit note"]')!);
    expect(node.querySelector<HTMLTextAreaElement>("#memory-note")!.value).toBe(memory.content);
    orgId = "second";
    await rerender();
    expect(node.querySelector("#memory-note")).toBeNull();
  });

  it("prevents duplicate saves and opening another note while a save is in flight", async () => {
    vi.spyOn(api, "memories").mockResolvedValue([]);
    const pending = deferred<ClientMemory>();
    const save = vi.spyOn(api, "addMemory").mockReturnValue(pending.promise);
    const { node } = await renderView(() => <MemoryRouter><ClientMemorySection orgId="first" /></MemoryRouter>);
    await click(node.querySelector(".section-title button")!);
    await change(node.querySelector<HTMLTextAreaElement>("#memory-note")!, "Printers use VLAN 20");
    await submit(node.querySelector("#memory-form")!);
    expect(node.querySelector<HTMLButtonElement>(".section-title button")!.disabled).toBe(true);
    await submit(node.querySelector("#memory-form")!);
    expect(save).toHaveBeenCalledTimes(1);
    await click(node.querySelector('.modal [aria-label="Close"]')!);
    expect(node.querySelector("#memory-note")).not.toBeNull();
    await act(async () => pending.resolve(memory));
    expect(node.querySelector("#memory-note")).toBeNull();
  });
});

describe("model price editing", () => {
  it("rejects a pasted negative price instead of silently saving a positive price", async () => {
    const model: ModelProfileListItem = {
      id: "model", name: "Local model", provider: "lmstudio", model: "local", base_url: "http://localhost:1234/v1", options: {},
      fallback_id: null, is_default: true, has_key: false, usedBy: [], created_at: "2026-09-01T00:00:00Z",
    };
    const preset: ModelProviderPreset = {
      id: "lmstudio", name: "LM Studio", license: "open", baseUrl: "http://localhost:1234/v1", needsKey: false, exampleModels: ["local"], notes: "",
    };
    vi.spyOn(api, "models").mockResolvedValue([model]);
    vi.spyOn(api, "modelProviders").mockResolvedValue([preset]);
    vi.spyOn(api, "orgs").mockResolvedValue([]);
    const save = vi.spyOn(api, "updateModel").mockResolvedValue(model);
    const { node } = await renderView(() => <MemoryRouter><ModelsPage /></MemoryRouter>);
    await click([...node.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit")!);
    await change(node.querySelector<HTMLInputElement>("#md-price-in")!, "-3");
    await change(node.querySelector<HTMLInputElement>("#md-price-out")!, "2");
    await submit(node.querySelector("#model-form")!);
    expect(save).not.toHaveBeenCalled();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Enter both prices");
    await change(node.querySelector<HTMLInputElement>("#md-price-in")!, "0");
    await change(node.querySelector<HTMLInputElement>("#md-price-out")!, "0");
    await submit(node.querySelector("#model-form")!);
    expect(save).toHaveBeenCalledWith("model", expect.objectContaining({ options: { inputUsdPerMTok: 0, outputUsdPerMTok: 0 } }));
  });
});

describe("usage clients", () => {
  const usage: UsageReport = {
      period: { from: "2026-09-01", to: "2026-10-01", days: 30 },
      settings: { aiMarkupPercent: 0, autoCloseResolvedDays: 7, minutesPerTicket: 20, minutesPerAction: 5 },
      clients: [{ orgId: "first", name: "First client", modelCalls: 0, inputTokens: 0, outputTokens: 0, unpricedTokens: 0, aiCostUsd: 0,
        billableAiUsd: 0, ticketsResolvedByHaley: 0, confirmedByRequester: 0, automaticChanges: 2, recipeRuns: 0, hoursSaved: 0.2 }],
      totals: { modelCalls: 0, inputTokens: 0, outputTokens: 0, unpricedTokens: 0, aiCostUsd: 0, billableAiUsd: 0,
        ticketsResolvedByHaley: 0, confirmedByRequester: 0, hoursSaved: 0.2 },
      unpricedModels: [], technicians: { names: [], count: 0, note: "Estimated" },
  };
  it("shows a client whose only usage is automatic changes", async () => {
    vi.spyOn(api, "usage").mockResolvedValue(usage);
    const { node } = await renderView(() => <MemoryRouter><UsagePage /></MemoryRouter>);
    expect(node.querySelector(".usage-table tbody")?.textContent).toContain("First client");
  });

  it("allows fractional markup and time estimates in the browser, while keeping auto-close days integral", async () => {
    vi.spyOn(api, "usage").mockResolvedValue(usage);
    const save = vi.spyOn(api, "updateBillingSettings").mockResolvedValue(usage.settings);
    const { node } = await renderView(() => <MemoryRouter><UsagePage /></MemoryRouter>);
    await click([...node.querySelectorAll("button")].find((b) => b.textContent?.includes("Billing settings"))!);
    await change(node.querySelector<HTMLInputElement>("#billing-aiMarkupPercent")!, "12.5");
    await change(node.querySelector<HTMLInputElement>("#billing-minutesPerTicket")!, "22.5");
    const form = node.querySelector<HTMLFormElement>("#billing-form")!;
    expect(form.checkValidity()).toBe(true);
    await change(node.querySelector<HTMLInputElement>("#billing-autoCloseResolvedDays")!, "1.5");
    expect(form.checkValidity()).toBe(false);
    expect(node.querySelector<HTMLButtonElement>('button[form="billing-form"]')!.disabled).toBe(true);
    await change(node.querySelector<HTMLInputElement>("#billing-autoCloseResolvedDays")!, "7");
    await submit(form);
    expect(save).toHaveBeenCalledWith({ ...usage.settings, aiMarkupPercent: 12.5, minutesPerTicket: 22.5 });
  });
});
