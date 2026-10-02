import { describe, expect, it } from "vitest";
import { builtinTools } from "../src/agent/builtinTools.js";
import { makeApp } from "./helpers.js";

describe("requester confirmation evidence", () => {
  async function setup() {
    const haley = await makeApp();
    const org = haley.store.createOrg({ name: "Confirmation client" });
    const ticket = haley.store.createTicket({ orgId: org.id, title: "Printer", requesterEmail: "megan@example.test" });
    const run = haley.store.createRun({ orgId: org.id, ticketId: ticket.id, kind: "ticket", title: "Confirm", instruction: "Confirm", createdBy: "chat" });
    const confirm = builtinTools(haley.store, run).find((t) => t.name === "confirm_resolution")!;
    const call = (evidence: string) => confirm.run({ evidence }, { orgId: org.id, runId: run.id, ticketId: ticket.id });
    return { ...haley, org, ticket, call };
  }

  it("rejects invented evidence after a requester says the issue is still broken", async () => {
    const { app, store, ticket, call } = await setup();
    try {
      store.setTicketStatus(ticket.id, "resolved", "haley");
      store.addTicketEvent(ticket.id, "comment", "Megan", "No, the printer is still broken.", { fromRequester: true });
      await expect(call("yes that worked, thanks")).rejects.toThrow(/latest.*reply|evidence/i);
      expect(store.getTicket(ticket.id)?.resolution_confirmed_at).toBeNull();
    } finally { await app.close(); }
  });

  it("requires evidence from the latest trusted reply, rather than an earlier confirmation", async () => {
    const { app, store, ticket, call } = await setup();
    try {
      store.setTicketStatus(ticket.id, "resolved", "haley");
      store.addTicketEvent(ticket.id, "comment", "Megan", "yes that worked, thanks", { fromRequester: true });
      store.addTicketEvent(ticket.id, "comment", "Megan", "Actually it stopped again.", { fromRequester: true });
      await expect(call("yes that worked, thanks")).rejects.toThrow(/latest.*reply|evidence/i);
    } finally { await app.close(); }
  });

  it("does not reuse a Haley resolution superseded by a technician resolution", async () => {
    const { app, store, ticket, call } = await setup();
    try {
      store.setTicketStatus(ticket.id, "resolved", "haley");
      store.setTicketStatus(ticket.id, "in_progress", "Jordan");
      store.setTicketStatus(ticket.id, "resolved", "Jordan");
      store.addTicketEvent(ticket.id, "comment", "Megan", "yes that worked, thanks", { fromRequester: true });
      await expect(call("yes that worked, thanks")).rejects.toThrow(/resolve|Haley/i);
    } finally { await app.close(); }
  });

  it("matches quotes despite curly apostrophes, quote marks and trailing punctuation", async () => {
    const { app, store, ticket, call } = await setup();
    try {
      store.setTicketStatus(ticket.id, "resolved", "haley");
      store.addTicketEvent(ticket.id, "comment", "Megan", "Yes \u2014 that\u2019s working now\u2026 thanks!", { fromRequester: true });
      await call('"Yes - that\'s working now."');
      expect(store.getTicket(ticket.id)?.resolution_confirmed_at).not.toBeNull();
    } finally { await app.close(); }
  });

  it("does not reuse a Haley resolution after a technician closed the ticket", async () => {
    const { app, store, ticket, call } = await setup();
    try {
      store.setTicketStatus(ticket.id, "resolved", "haley");
      store.setTicketStatus(ticket.id, "closed", "Jordan");
      store.addTicketEvent(ticket.id, "comment", "Megan", "yes that worked, thanks", { fromRequester: true });
      await expect(call("yes that worked, thanks")).rejects.toThrow(/resolve|Haley/i);
    } finally { await app.close(); }
  });

  it("clears current confirmation when a closed ticket is reopened", async () => {
    const { app, store, ticket, call } = await setup();
    try {
      store.setTicketStatus(ticket.id, "resolved", "haley");
      store.addTicketEvent(ticket.id, "comment", "Megan", "Yes, that worked!", { fromRequester: true });
      await call("Yes, that worked!");
      expect(store.getTicket(ticket.id)?.resolution_confirmed_at).not.toBeNull();
      store.setTicketStatus(ticket.id, "in_progress", "haley");
      expect(store.getTicket(ticket.id)?.resolution_confirmed_at).toBeNull();
    } finally { await app.close(); }
  });
});
