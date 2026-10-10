import { describe, expect, it } from "vitest";
import { sign } from "../src/channels/chat.js";
import { nameSimilarity, samePhone } from "../src/channels/phone.js";
import { fakeFetch, firstUserText, makeApp, ScriptedLlm, testConfig, text, toolUse, turn } from "./helpers.js";

const SECRET = "voice-secret";
// Megan Bowen's number in the sandbox Microsoft 365 directory.
const MEGAN = "(425) 555-0109";

async function setup(llm = new ScriptedLlm(turn(text("Looking into it.")))) {
  const sent: Array<Record<string, unknown>> = [];
  const net = fakeFetch([[/recordings\.example/, () => new Response("audio")]]);
  const base = testConfig();
  const haley = await makeApp(
    llm,
    { channels: { ...base.channels, voiceWebhookSecret: SECRET, smtpFrom: "IT <it@msp.example>" } },
    net.impl,
    { sendMail: async (m) => void sent.push(m) },
  );
  const { app, store } = haley;
  const contoso = store.createOrg({ name: "Contoso Ltd", domain: "contoso.example", autonomy: "unattended" });
  store.createIntegration({ orgId: contoso.id, provider: "m365", label: "Contoso M365", mode: "sandbox", config: {} });
  const call = async (body: Record<string, unknown>, secret = SECRET) => {
    const raw = JSON.stringify(body);
    return app.inject({ method: "POST", url: "/hooks/voice", headers: { "content-type": "application/json", "x-haley-signature": sign(secret, raw) }, payload: raw });
  };
  return { ...haley, sent, net, contoso, call };
}

const settle = async (haley: Awaited<ReturnType<typeof setup>>, ticketId: string) => {
  const run = haley.store.listRuns({ ticketId })[0];
  if (run) await haley.agent.settled(run.id);
};

describe("phone numbers and company names", () => {
  it("compares numbers by their last ten digits, whatever the format", () => {
    expect(samePhone("(425) 555-0109", "+1 425 555 0109")).toBe(true);
    expect(samePhone("+44 20 7946 0958", "020 7946 0958")).toBe(true);
    expect(samePhone("+1 425 555 0109", "+1 425 555 0110")).toBe(false);
    expect(samePhone("123", "123")).toBe(false);
    expect(nameSimilarity("Contoso Ltd", "contoso")).toBe(1);
    expect(nameSimilarity("Fabrikam Inc.", "Fabrikkam")).toBeGreaterThan(0.8);
    expect(nameSimilarity("Contoso", "Northwind")).toBeLessThan(0.5);
  });
});

describe("phone intake", () => {
  it("checks the signature and needs something to work with", async () => {
    const { app, call } = await setup();
    expect((await call({ callId: "c1", from: MEGAN, to: "+18005550100", transcript: "Hi" }, "wrong")).statusCode).toBe(401);
    expect((await call({ callId: "c1", from: MEGAN, to: "+18005550100", transcript: "  " })).statusCode).toBe(400);
    expect((await call({ callId: "c1", from: MEGAN, transcript: "Hi", recordingUrl: "http://insecure.example/x" })).statusCode).toBe(400);
    await app.close();
  });

  it("matches the caller in the client's directory, never trusts caller ID, and answers by email", async () => {
    const haley = await setup();
    const { store, sent, net, call } = haley;
    const res = await call({
      callId: "call-1",
      from: MEGAN,
      to: "+1 800 555 0100",
      startedAt: "2026-10-09T15:04:00Z",
      durationSec: 184,
      callerName: "Megan",
      summary: "Outlook keeps asking for a password",
      transcript: "Hi, it's Megan from marketing. Outlook keeps asking for my password. Please reset it to Summer2026!",
      recordingUrl: "https://recordings.example/call-1.mp3",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "created", matched: true });
    const ticket = store.getTicket(res.json().ticketId)!;
    await settle(haley, ticket.id);
    expect(ticket).toMatchObject({ channel: "phone", requester_email: "megan.bowen@contoso.example", requester_name: "Megan Bowen", assurance: "none", title: "Outlook keeps asking for a password" });
    expect(ticket.description).toContain("Caller ID can be faked");
    expect(ticket.description).toContain("(2026-10-09 15:04 UTC, 3 min)");
    // The recording is a link for technicians only.
    expect(ticket.channel_ref.recordingUrl).toBe("https://recordings.example/call-1.mp3");
    expect(ticket.description).not.toContain("recordings.example");
    expect(net.calls.some((c) => c.url.includes("recordings.example"))).toBe(false);
    // Haley's acknowledgement went by email to the directory address, not to the caller's number.
    expect(sent.map((m) => m.to)).toEqual([`"Megan Bowen" <megan.bowen@contoso.example>`]);

    // The service retried: same ticket.
    const again = await call({ callId: "call-1", from: MEGAN, to: "+1 800 555 0100", transcript: "again" });
    expect(again.json()).toMatchObject({ status: "duplicate", ticketId: ticket.id });
    await haley.app.close();
  });

  it("tells Haley the caller isn't verified, so a password reset doesn't run on the call alone", async () => {
    const llm = new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "megan.bowen@contoso.example" })), turn(text("I need to verify you first.")));
    const haley = await setup(llm);
    const res = await haley.call({ callId: "call-2", from: MEGAN, to: "", transcript: "Reset my password please" });
    const ticket = haley.store.getTicket(res.json().ticketId)!;
    await settle(haley, ticket.id);
    const intro = firstUserText(llm.requests[0]);
    expect(intro).toContain("Caller ID can be faked, so the caller's identity is NOT verified");
    expect(intro).toContain("Never reset a password or MFA method on the strength of the call alone");
    // Even on an unattended client, the reset doesn't happen.
    const [reset] = haley.store.listActions({ runId: haley.store.listRuns({ ticketId: ticket.id })[0].id });
    expect(reset.tool).toBe("m365_reset_password");
    expect(reset.status).not.toBe("executed");
    await haley.app.close();
  });

  it("uses the number dialled when the MSP has a line per client", async () => {
    const haley = await setup();
    const fabrikam = haley.store.createOrg({ name: "Fabrikam", domain: "fabrikam.example" });
    haley.store.updateOrg(fabrikam.id, { settings: { phoneNumbers: ["+1 800 555 0177"] } });
    const res = await haley.call({ callId: "call-3", from: "+1 206 555 0123", to: "18005550177", callerName: "Sam", transcript: "The printer is jammed" });
    expect(res.json()).toMatchObject({ status: "created", orgId: fabrikam.id, matched: false });
    const ticket = haley.store.getTicket(res.json().ticketId)!;
    expect(ticket).toMatchObject({ requester_name: "Sam", requester_email: "" });
    expect(ticket.description).toContain("doesn't match anyone in the client's directory");
    await settle(haley, ticket.id);
    await haley.app.close();
  });

  it("guesses the client from the company named, for a technician to confirm, and refuses calls it can't place", async () => {
    const haley = await setup();
    const northwind = haley.store.createOrg({ name: "Northwind Traders", domain: "northwind.example" });
    const res = await haley.call({ callId: "call-4", from: "+1 206 555 0199", to: "", company: "Northwind Traders Inc", transcript: "Our internet is down" });
    expect(res.json()).toMatchObject({ status: "created", orgId: northwind.id, runId: null });
    const ticket = haley.store.getTicket(res.json().ticketId)!;
    expect(ticket.assignee).toBe("unassigned");
    expect(haley.store.listTicketEvents(ticket.id).some((e) => e.body.includes('Client guessed from the caller saying "Northwind Traders Inc"'))).toBe(true);
    expect(haley.store.listRuns({ ticketId: ticket.id })).toEqual([]);

    const lost = await haley.call({ callId: "call-5", from: "+1 206 555 0100", to: "", company: "Unknown Co", transcript: "Hello?" });
    expect(lost.statusCode).toBe(422);
    expect(haley.store.listAudit({ limit: 5 }).some((a) => a.action === "phone.unmatched" && a.target === "call-5")).toBe(true);
    await haley.app.close();
  });
});
