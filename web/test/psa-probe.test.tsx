import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type PsaConnection } from "../src/api";
import { PsaProbeModal } from "../src/components/PsaProbe";
import { renderView } from "./renderHook";

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});

const connection = { id: "psa_1", kind: "autotask", name: "Autotask" } as PsaConnection;

describe("PSA field check", () => {
  it("shows each step's fields with fill counts, flags empty fields, and shows failures", async () => {
    const probe = vi.spyOn(api, "probePsa").mockResolvedValue({
      connectionId: "psa_1",
      kind: "autotask",
      at: "2026-10-09T00:00:00Z",
      steps: [
        { method: "test", ok: true, ms: 120, detail: "Connected to Autotask", fields: [] },
        {
          method: "listClosedTickets",
          ok: true,
          ms: 800,
          detail: "5 closed in the last 30 days",
          fields: [
            { field: "subject", types: ["string"], filled: 5, total: 5 },
            { field: "category", types: ["null"], filled: 0, total: 5 },
          ],
        },
        { method: "getTicket", ok: false, ms: 50, detail: "Autotask GET /Tickets/1 failed (403)", fields: [] },
      ],
    });
    const { node } = await renderView(() => (
      <MemoryRouter>
        <PsaProbeModal connection={connection} open onClose={() => {}} />
      </MemoryRouter>
    ));
    expect(probe).toHaveBeenCalledWith("psa_1");
    expect(node.textContent).toContain("Closed tickets (reports)");
    const rows = [...node.querySelectorAll(".probe-table tbody tr")];
    expect(rows.map((r) => r.textContent)).toEqual(["subjectstring5 of 5", "categorynull0 of 5"]);
    expect(rows[1].classList.contains("is-empty")).toBe(true);
    expect(node.querySelector(".probe-step.is-error")!.textContent).toContain("failed (403)");
  });
});
