import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type InsightReport, type PsaProviderInfo } from "../src/api";
import { InsightReportPage, InsightsPage } from "../src/pages/Insights";
import { renderView } from "./renderHook";

vi.mock("../src/lib/app-context", () => ({
  useApp: () => ({ toast: vi.fn(), user: "Jordan" }),
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

async function change(node: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (node: Element, text: string) => [...node.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

const halo: PsaProviderInfo = {
  id: "halopsa",
  name: "HaloPSA",
  description: "",
  insights: true,
  setupSteps: [],
  fields: [
    { key: "instance", label: "Instance URL" },
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
    { key: "team", label: "Team", optional: true },
  ],
};

const report: InsightReport = {
  id: "ins_1",
  created_by: "Jordan",
  params: { source: { kind: "halopsa", label: "Northwind", connectionId: null }, days: 90, minutesPerTicket: 15, from: "2026-07-10T00:00:00Z", to: "2026-10-08T00:00:00Z" },
  status: "done",
  error: null,
  created_at: "2026-10-08T00:00:00Z",
  finished_at: "2026-10-08T00:01:00Z",
  result: {
    period: { from: "2026-07-10T00:00:00Z", to: "2026-10-08T00:00:00Z", days: 90 },
    source: { kind: "halopsa", label: "Northwind" },
    totals: { tickets: 300, ticketsPerMonth: 100, coveredTicketsPerMonth: 40, coveredHoursPerMonth: 12.5, groupedTickets: 200 },
    clusters: [
      {
        id: "g1", label: "Password resets and lockouts", terms: ["password", "reset"], tickets: 90, ticketsPerMonth: 30, minutesPerTicket: 10, minutesSource: "psa", hoursPerMonth: 5,
        coverage: "unattended", capability: "password", recipes: [{ id: "password-reset", name: "Password reset" }],
        integrations: [{ providers: ["m365", "google"], names: ["Microsoft 365", "Google Workspace"], connected: null }], samples: ["Megan locked out"],
      },
      {
        id: "g2", label: "Sage 50 crashes", terms: ["sage", "crash"], tickets: 30, ticketsPerMonth: 10, minutesPerTicket: 60, minutesSource: "estimate", hoursPerMonth: 10,
        coverage: "not covered", capability: null, recipes: [], integrations: [], samples: ["Sage crashes on launch"],
      },
    ],
    other: { tickets: 100 },
    model: { used: true, inputTokens: 1000, outputTokens: 200 },
    truncated: false,
  },
};

describe("what would Haley handle", () => {
  it("starts a prospect report without a saved connection, sending only the filled-in fields", async () => {
    vi.spyOn(api, "insights").mockResolvedValue([]);
    vi.spyOn(api, "psaProviders").mockResolvedValue([halo, { ...halo, id: "autotask", name: "Autotask", insights: false }]);
    vi.spyOn(api, "psaConnections").mockResolvedValue([]);
    const start = vi.spyOn(api, "startInsight").mockResolvedValue({ ...report, status: "running", result: null });
    const { node } = await renderView(() => (
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>
    ));
    expect(node.textContent).toContain("No reports yet");
    await click(button(node, "New report"));
    expect(node.textContent).toContain("never saved");
    expect(node.querySelector("#insight-kind")!.textContent).not.toContain("Autotask");
    expect(node.querySelector("#insight-team")).toBeNull();
    const submit = node.querySelector<HTMLButtonElement>('button[form="insight-form"]')!;
    expect(submit.disabled).toBe(true);
    await change(node.querySelector<HTMLInputElement>("#insight-instance")!, "https://northwind.halopsa.com");
    await change(node.querySelector<HTMLInputElement>("#insight-clientId")!, "app");
    await change(node.querySelector<HTMLInputElement>("#insight-clientSecret")!, "s3cret");
    await change(node.querySelector<HTMLInputElement>("#insight-name")!, "Northwind");
    await click(button(node, "30 days"));
    expect(submit.disabled).toBe(false);
    await act(async () => { node.querySelector("#insight-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(start).toHaveBeenCalledWith({
      days: 30,
      minutesPerTicket: undefined,
      prospect: { kind: "halopsa", name: "Northwind", config: { instance: "https://northwind.halopsa.com", clientId: "app", clientSecret: "s3cret" } },
    });
  });

  it("shows the headline, ranks groups by hours, and hides example subjects until asked", async () => {
    vi.spyOn(api, "insight").mockResolvedValue(report);
    const csv = vi.spyOn(api, "downloadInsightCsv").mockResolvedValue();
    const { node } = await renderView(() => (
      <MemoryRouter initialEntries={["/insights/ins_1"]}>
        <Routes>
          <Route path="/insights/:id" element={<InsightReportPage />} />
        </Routes>
      </MemoryRouter>
    ));
    expect(node.querySelector(".insight-headline")!.textContent).toContain("about 40 tickets a month (40% of 100)");
    expect(node.querySelector(".insight-headline")!.textContent).toContain("12.5 technician hours");
    const rows = [...node.querySelectorAll(".insight-table tbody tr")];
    expect(rows[0].textContent).toContain("Sage 50 crashes");
    expect(rows[0].textContent).toContain("Not covered");
    expect(rows[1].textContent).toContain("Unattended");
    expect(rows[1].textContent).toContain("Microsoft 365 or Google Workspace");
    expect(node.textContent).not.toContain("Megan locked out");
    await click(node.querySelector('[role="switch"]')!);
    expect(node.textContent).toContain("Megan locked out");
    await click(button(node, "CSV"));
    expect(csv).toHaveBeenCalledWith("ins_1", true);
  });
});
