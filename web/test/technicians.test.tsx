import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Technician } from "../src/api";
import { TechniciansPage } from "../src/pages/Technicians";
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

const dana: Technician = {
  id: "tech_dana", name: "Dana Reyes", email: "dana@msp.example", slack_user_id: "U0DANA1", teams_aad_id: null, psa_refs: {}, active: true,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};

const button = (node: Element, text: string) => [...node.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

describe("technician directory page", () => {
  it("lists technicians with their chat links, offers names in use, and prompts the signed-in technician to add themselves", async () => {
    vi.spyOn(api, "technicians").mockResolvedValue({ technicians: [dana, { ...dana, id: "tech_old", name: "Old Tech", email: null, slack_user_id: null, active: false }], suggestions: ["Sam Lee"] });
    const { node } = await renderView(() => <MemoryRouter><TechniciansPage /></MemoryRouter>);
    const rows = [...node.querySelectorAll(".technicians-table tbody tr")];
    expect(rows[0].textContent).toContain("Dana Reyes");
    expect(rows[0].textContent).toContain("Slack linked");
    expect(rows[1].textContent).toContain("Inactive");
    expect(node.textContent).toContain("You're signed in as Jordan, who isn't in the directory yet.");
    expect(button(node, "Sam Lee")).toBeTruthy();
  });

  it("adds a suggested name with an email, and validates the form", async () => {
    vi.spyOn(api, "technicians").mockResolvedValue({ technicians: [], suggestions: ["Sam Lee"] });
    const add = vi.spyOn(api, "addTechnician").mockResolvedValue({ ...dana, id: "tech_sam", name: "Sam Lee" });
    const { node } = await renderView(() => <MemoryRouter><TechniciansPage /></MemoryRouter>);
    await click(button(node, "Sam Lee"));
    expect(node.querySelector<HTMLInputElement>("#tech-name")!.value).toBe("Sam Lee");
    const save = node.querySelector<HTMLButtonElement>('button[form="technician-form"]')!;
    await change(node.querySelector<HTMLInputElement>("#tech-email")!, "not-an-email");
    expect(save.disabled).toBe(true);
    await change(node.querySelector<HTMLInputElement>("#tech-email")!, "sam@msp.example");
    expect(save.disabled).toBe(false);
    await act(async () => { node.querySelector("#technician-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(add).toHaveBeenCalledWith({ name: "Sam Lee", email: "sam@msp.example" });
  });

  it("unlinks a chat account and warns that renaming updates client rules", async () => {
    vi.spyOn(api, "technicians").mockResolvedValue({ technicians: [dana], suggestions: [] });
    const update = vi.spyOn(api, "updateTechnician").mockResolvedValue(dana);
    const { node } = await renderView(() => <MemoryRouter><TechniciansPage /></MemoryRouter>);
    await click(node.querySelector('[aria-label="Edit Dana Reyes"]')!);
    await change(node.querySelector<HTMLInputElement>("#tech-name")!, "Dana R.");
    expect(node.textContent).toContain("Rules that name Dana Reyes as an approver will be updated to Dana R.");
    await change(node.querySelector<HTMLInputElement>("#tech-slack")!, "");
    await act(async () => { node.querySelector("#technician-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(update).toHaveBeenCalledWith("tech_dana", { name: "Dana R.", email: "dana@msp.example", slackUserId: null, teamsAadId: null });
  });
});
