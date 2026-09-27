import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { DuoVerifier, signDuo } from "../src/connectors/verification/duo.js";
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

describe("Duo push", () => {
  const creds = { integrationKey: "DIXXXXXXXXXXXXXXXXXX", secretKey: "duo-secret-key", apiHostname: "API-Example.duosecurity.com" };

  it("signs requests with Duo's v5 scheme", () => {
    // Body hash from Duo's documentation example.
    const docBody = '{"device":"auto","factor":"push","hostname":"wks01","ipaddr":"10.2.3.4","username":"narroway"}';
    const docHash = createHash("sha512").update(docBody).digest("hex");
    expect(docHash.startsWith("571f07f529b16c2a")).toBe(true);
    expect(docHash.endsWith("638aeb")).toBe(true);

    const date = "Tue, 21 Aug 2012 17:29:18 GMT";
    const post = signDuo(creds, "POST", "/auth/v2/auth", { username: "a b@x.example", factor: "push" }, date);
    const body = '{"username":"a b@x.example","factor":"push"}';
    expect(post.body).toBe(body);
    const emptyHash = createHash("sha512").update("").digest("hex");
    const canonical = [date, "POST", "api-example.duosecurity.com", "/auth/v2/auth", "", createHash("sha512").update(body).digest("hex"), emptyHash].join("\n");
    const expectedSig = createHmac("sha512", "duo-secret-key").update(canonical).digest("hex");
    expect(Buffer.from(post.headers.authorization.slice(6), "base64").toString()).toBe(`DIXXXXXXXXXXXXXXXXXX:${expectedSig}`);
    expect(post.headers).toMatchObject({ date, "content-type": "application/json" });

    const get = signDuo(creds, "GET", "/auth/v2/auth_status", { txid: "t 1", b: "~x" }, date);
    expect(get.url).toBe("https://api-example.duosecurity.com/auth/v2/auth_status?b=~x&txid=t%201");
    expect(get.body).toBeUndefined();
  });

  function duo(statuses: Array<Record<string, unknown> | "longpoll-timeout">, preauth: Record<string, unknown> = { result: "auth", devices: [{ device: "D1", display_name: "iPhone", capabilities: ["auto", "push"] }] }) {
    const queue = [...statuses];
    return fakeFetch([
      [/\/auth\/v2\/check/, () => ({ stat: "OK", response: { time: 1 } })],
      [/\/auth\/v2\/preauth/, () => ({ stat: "OK", response: preauth })],
      [/\/auth\/v2\/auth$/, () => ({ stat: "OK", response: { txid: "tx-1" } })],
      [/\/auth\/v2\/auth_status/, () => {
        const next = queue.shift()!;
        return next === "longpoll-timeout"
          ? new Response(JSON.stringify({ stat: "FAIL", code: 40002, message: "Invalid request parameters" }), { status: 400 })
          : { stat: "OK", response: next };
      }],
    ]);
  }

  it("pushes to the user's device and waits for the answer", async () => {
    const net = duo(["longpoll-timeout", { result: "waiting", status: "pushed" }, { result: "allow", status: "allow" }]);
    const v = new DuoVerifier({ ...creds, usernameFormat: "local" }, net.impl);
    expect(await v.verify("sam.chen@acme.example", { reason: "Password reset", ticketNumber: 12 })).toMatchObject({ outcome: "approved" });
    const auth = net.calls.find((c) => c.url.endsWith("/auth/v2/auth"))!.json();
    expect(auth).toMatchObject({ username: "sam.chen", factor: "push", device: "auto", async: "1", display_username: "sam.chen@acme.example" });
    expect(new URLSearchParams(auth.pushinfo).get("Ticket")).toBe("#12");
  });

  it("reports fraud as a denial, and can't verify unenrolled or bypass users", async () => {
    const fraud = new DuoVerifier(creds, duo([{ result: "deny", status: "fraud" }]).impl);
    expect(await fraud.verify("a@x.example", { reason: "r", ticketNumber: null })).toMatchObject({ outcome: "denied", detail: expect.stringContaining("fraud") });
    const timeout = new DuoVerifier(creds, duo([{ result: "deny", status: "timeout" }]).impl);
    expect((await timeout.verify("a@x.example", { reason: "r", ticketNumber: null })).outcome).toBe("timeout");
    const enroll = new DuoVerifier(creds, duo([], { result: "enroll" }).impl);
    expect((await enroll.verify("a@x.example", { reason: "r", ticketNumber: null })).outcome).toBe("unavailable");
    const bypass = new DuoVerifier(creds, duo([], { result: "allow" }).impl);
    expect(await bypass.verify("a@x.example", { reason: "r", ticketNumber: null })).toMatchObject({ outcome: "unavailable", detail: expect.stringContaining("bypass") });
  });

  it("escalates the ticket when the owner denies the push", async () => {
    const llm = new ScriptedLlm(
      turn(toolUse("verify_requester_identity", { reason: "Password reset" })),
      turn(toolUse("m365_reset_password", { user: "lynne.robbins@contoso.example" })),
      turn(text("Stopped.")),
    );
    const net = duo([{ result: "deny", status: "deny" }]);
    const sent: Array<Record<string, unknown>> = [];
    const haley = await makeApp(llm, { channels: { ...testConfig().channels, emailHookSecret: "hook" } }, net.impl, { sendMail: async (m) => void sent.push(m) });
    const { app, store, agent } = haley;
    await app.inject({ method: "POST", url: "/api/demo" });
    const contoso = store.listOrgs().find((o) => o.name === "Contoso Ltd")!;
    await app.inject({ method: "PATCH", url: `/api/orgs/${contoso.id}`, payload: { autonomy: "unattended" } });
    const integration = await app.inject({
      method: "POST",
      url: `/api/orgs/${contoso.id}/integrations`,
      payload: { provider: "duo", mode: "live", config: { integrationKey: "DI1", secretKey: "s", apiHostname: "api-1.duosecurity.com" } },
    });
    expect(integration.json()).toMatchObject({ status: "connected" });
    const res = await app.inject({
      method: "POST",
      url: "/hooks/email?key=hook",
      payload: { from: "lynne.robbins@contoso.example", fromName: "Lynne", subject: "Reset please", text: "reset", authenticationResults: DMARC },
    });
    await agent.settled(res.json().runId);
    const ticket = store.getTicket(res.json().ticketId)!;
    expect(ticket).toMatchObject({ status: "escalated", mfa_verified_at: null });
    const reset = store.listActions().find((a) => a.tool === "m365_reset_password")!;
    expect(reset).toMatchObject({ status: "blocked", policy_reason: expect.stringContaining("possible impersonation") });
    expect(sent.some((m) => String(m.text).includes("quick sign-off"))).toBe(false);
    expect(store.listAudit().map((a) => a.action)).toContain("verification.denied");
  });
});
