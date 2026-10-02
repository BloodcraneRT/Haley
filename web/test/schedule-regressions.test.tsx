import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Schedule, type TaskTemplate } from "../src/api";
import { NewScheduleModal } from "../src/components/Schedules";
import { deferred, renderView } from "./renderHook";

vi.mock("../src/lib/app-context", () => ({ useApp: () => ({ toast: vi.fn(), refreshStats: vi.fn() }) }));

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});

const recipe: TaskTemplate = {
  id: "license-audit", name: "License audit", description: "Check licenses", instruction: "Audit licenses",
  category: "Licensing & cost", requires: [["m365"]], tools: [], changes: false, estimatedMinutes: 20,
  tags: [], available: true, missing: [],
};

async function select(node: Element, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function submit(node: Element) {
  await act(async () => { node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

describe("client schedule recipes", () => {
  it("loads this client's availability and preserves the chosen recipe on submission", async () => {
    const templates = vi.spyOn(api, "templates").mockResolvedValue([recipe]);
    const create = vi.spyOn(api, "createSchedule").mockResolvedValue({ id: "schedule", title: recipe.name } as Schedule);
    const { node } = await renderView(() => <NewScheduleModal open orgId="first" orgName="First" onClose={() => {}} onCreated={() => {}} />);
    expect(templates).toHaveBeenCalledWith("first");
    await select(node.querySelector("#ns-template")!, recipe.id);
    await submit(node.querySelector("form")!);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ orgId: "first", templateId: recipe.id }));
  });

  it("disables unavailable recipes and refuses a submitted unsupported selection", async () => {
    vi.spyOn(api, "templates").mockResolvedValue([{ ...recipe, available: false, missing: ["Microsoft 365"] }]);
    const create = vi.spyOn(api, "createSchedule");
    const { node } = await renderView(() => <NewScheduleModal open orgId="google" orgName="Google client" onClose={() => {}} onCreated={() => {}} />);
    expect(node.querySelector<HTMLOptionElement>(`option[value="${recipe.id}"]`)!.disabled).toBe(true);
    expect(node.textContent).toContain("Microsoft 365");
    await select(node.querySelector("#ns-template")!, recipe.id);
    await submit(node.querySelector("form")!);
    expect(create).not.toHaveBeenCalled();
  });

  it("blocks stale recipe submission while client availability reloads, surfaces failures and retries", async () => {
    const pending = deferred<TaskTemplate[]>();
    const templates = vi.spyOn(api, "templates").mockImplementation((id) => id === "second" ? pending.promise : Promise.resolve([recipe]));
    const create = vi.spyOn(api, "createSchedule");
    let orgId = "first";
    const { node, rerender } = await renderView(() => <NewScheduleModal open orgId={orgId} orgName={orgId} onClose={() => {}} onCreated={() => {}} />);
    await select(node.querySelector("#ns-template")!, recipe.id);
    orgId = "second";
    await rerender();
    expect(node.querySelector<HTMLSelectElement>("#ns-template")!.disabled).toBe(true);
    await submit(node.querySelector("form")!);
    expect(create).not.toHaveBeenCalled();
    await act(async () => pending.reject(new Error("Availability unavailable")));
    expect(node.textContent).toContain("Availability unavailable");
    templates.mockResolvedValue([recipe]);
    await act(async () => [...node.querySelectorAll("button")].find((b) => b.textContent?.includes("Retry"))!.click());
    expect(node.querySelector<HTMLSelectElement>("#ns-template")!.disabled).toBe(false);
  });
});
