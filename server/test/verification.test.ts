import { describe, expect, it } from "vitest";
import { SmsCodeVerifier } from "../src/connectors/verification/sms.js";
import { fakeFetch, firstUserText, lastToolResults, makeApp, ScriptedLlm, testConfig, text, toolUse, turn } from "./helpers.js";

const DMARC = "mx.example; dkim=pass header.d=contoso.example; dmarc=pass";

async function setup(llm: ScriptedLlm) {
  const sent: Array<Record<string, unknown>> = [];
  const haley = await makeApp(
    llm,
    { channels: { ...testConfig().channels, emailHookSecret: "hook", publicUrl: "https://haley.example" } },
    undefined,
    { sendMail: async (m) => void sent.push(m) },
  );
  const { app, store } = haley;
  await app.inject({ method: "POST", url: "/api/demo" });
  const contoso = store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
  await app.inject({ method: "PATCH", url: `/api/orgs/${contoso.id}`, payload: { autonomy: "unattended" } });
  const sms = await app.inject({ method: "POST", url: `/api/orgs/${contoso.id}/integrations`, payload: { provider: "sms_code", mode: "sandbox" } });
  expect(sms.json()).toMatchObject({ status: "connected" });
  const email = (subject: string, body: string) =>
    app.inject({
      method: "POST",
      url: "/hooks/email?key=hook",
      payload: { from: "lynne.robbins@contoso.example", fromName: "Lynne Robbins", subject, text: body, authenticationResults: DMARC },
    });
  return { ...haley, contoso, sent, email };
}

describe("step-up verification", () => {
  it("lets an email requester verify with a code to their phone on file, then self-serve with a one-time link", async () => {
    let issuedCode = "";
    const llm = new ScriptedLlm(
      turn(toolUse("verify_requester_identity", { reason: "Password reset" })),
      turn(text("I've texted you a code; reply with it.")),
      (req) => {
        issuedCode = /comment by Lynne Robbins: (\d{6})/.exec(firstUserText(req))?.[1] ?? "";
        return { content: [toolUse("confirm_verification_code", { code: issuedCode })] };
      },
      turn(toolUse("m365_reset_password", { user: "lynne.robbins@contoso.example" })),
      turn(text("Reset done; the password went to you by one-time link.")),
    );
    const { store, agent, sent, email, app } = await setup(llm);

    const opened = (await email("Locked out", "Please reset my password")).json();
    await agent.settled(opened.runId);
    const ticket = store.getTicket(opened.ticketId)!;
    expect(ticket.assurance).toBe("email");
    const [result] = lastToolResults(llm.requests[1]);
    expect(result.content).toContain("code_sent");
    const note = store.listTicketEvents(ticket.id).find((e) => e.meta.sandbox)!;
    expect(note.body).toContain("+15550142");
    const code = /is (\d{6})/.exec(note.body)![1];
    // The code must not reach the model through the ticket history.
    expect(JSON.stringify(llm.requests)).not.toContain(code);

    const reply = (await email(`Re: [#${ticket.number}] Locked out`, `${code}`)).json();
    await agent.settled(reply.runId);
    expect(issuedCode).toBe(code);
    expect(store.getTicket(ticket.id)).toMatchObject({ mfa_method: "SMS code" });
    const reset = store.listActions().find((a) => a.tool === "m365_reset_password")!;
    expect(reset).toMatchObject({ status: "executed", decided_by: null });

    const linkMail = sent.find((m) => String(m.text).includes("https://haley.example/s/"))!;
    const token = /\/s\/([A-Za-z0-9_-]+)/.exec(String(linkMail.text))![1];
    expect(String(linkMail.text)).not.toContain(store.revealActionSecrets(reset.id)!.temporaryPassword);
    const page = await app.inject({ url: `/s/${token}` });
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).not.toContain(store.revealActionSecrets(reset.id)!.temporaryPassword);
    const revealed = await app.inject({ method: "POST", url: `/s/${token}/reveal` });
    expect(revealed.json().items.map((i: { value: string }) => i.value)).toContain(store.revealActionSecrets(reset.id)!.temporaryPassword);
    expect((await app.inject({ method: "POST", url: `/s/${token}/reveal` })).statusCode).toBe(410);
    expect(store.listAudit().map((a) => a.action)).toEqual(expect.arrayContaining(["verification.code_sent", "verification.approved", "secret.link_viewed"]));
  });

  it("without verification, email identity alone still can't reset a password", async () => {
    const llm = new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "lynne.robbins@contoso.example" })), turn(text("Waiting.")));
    const { store, agent, email } = await setup(llm);
    const opened = (await email("Locked out", "reset please")).json();
    await agent.settled(opened.runId);
    expect(store.listActions({ status: "pending_approval" })[0].policy_reason).toMatch(/stronger identity than email/);
  });

  it("escalates after too many wrong codes and refuses to verify again", async () => {
    const wrong = () => turn(toolUse("confirm_verification_code", { code: "000000" }));
    const llm = new ScriptedLlm(
      turn(toolUse("verify_requester_identity", { reason: "Reset" })),
      wrong(),
      wrong(),
      wrong(),
      wrong(),
      wrong(),
      turn(toolUse("verify_requester_identity", { reason: "Again" })),
      turn(text("Handing off.")),
    );
    const { store, agent, email } = await setup(llm);
    const opened = (await email("Locked out", "reset")).json();
    await agent.settled(opened.runId);
    const ticket = store.getTicket(opened.ticketId)!;
    expect(ticket).toMatchObject({ status: "escalated", assignee: "unassigned", mfa_verified_at: null });
    const last = lastToolResults(llm.requests[7])[0];
    expect(last).toMatchObject({ is_error: true, content: expect.stringContaining("already failed") });
  });

  it("only texts the number on file and limits guesses", async () => {
    const twilio = fakeFetch([[/api\.twilio\.com/, () => ({ sid: "SM1", status: "queued" })]]);
    const v = new SmsCodeVerifier({ accountSid: "AC1", authToken: "t", from: "+15550000000" }, async () => "+1 555-0142", twilio.impl);
    expect(await v.verify("a@x.example", { reason: "r", ticketNumber: 7 })).toMatchObject({ outcome: "code_sent" });
    const form = new URLSearchParams(twilio.calls[0].body);
    expect(form.get("To")).toBe("+15550142");
    expect(twilio.calls[0].headers.authorization).toBe(`Basic ${Buffer.from("AC1:t").toString("base64")}`);
    const code = /is (\d{6})/.exec(form.get("Body")!)![1];
    expect((await v.checkCode("a@x.example", "111111")).outcome).toBe("wrong_code");
    expect((await v.checkCode("a@x.example", code)).outcome).toBe("approved");
    expect((await v.checkCode("a@x.example", code)).outcome).toBe("timeout");
    const none = new SmsCodeVerifier(null, async () => null);
    expect((await none.verify("b@x.example", { reason: "r", ticketNumber: null })).outcome).toBe("unavailable");
  });
});
