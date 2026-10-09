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
