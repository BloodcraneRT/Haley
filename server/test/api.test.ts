import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LiveGoogleApi } from "../src/connectors/google/live.js";
import { GraphM365Api } from "../src/connectors/m365/graph.js";
import { makeApp, ScriptedLlm, text, toolUse, turn } from "./helpers.js";

describe("HTTP API", () => {
  it("requires the bearer token when configured", async () => {
    const { app } = await makeApp(undefined, { apiToken: "t0ken" });
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/orgs" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/orgs", headers: { authorization: "Bearer nope!" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/orgs", headers: { authorization: "Bearer t0ken" } })).statusCode).toBe(200);
  });

  it("seeds a demo workspace once", async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: "POST", url: "/api/demo" })).statusCode).toBe(200);
    const orgs = (await app.inject({ url: "/api/orgs" })).json();
    expect(orgs).toHaveLength(2);
    expect(orgs.flatMap((o: { integrations: unknown[] }) => o.integrations)).toHaveLength(2);
    const tickets = (await app.inject({ url: "/api/tickets?status=open" })).json();
    expect(tickets.length).toBeGreaterThanOrEqual(4);
    expect((await app.inject({ method: "POST", url: "/api/demo" })).statusCode).toBe(409);
  });

  it("connects a sandbox integration and lists its tools without leaking config", async () => {
    const { app } = await makeApp();
    const org = (await app.inject({ method: "POST", url: "/api/orgs", payload: { name: "Acme", domain: "acme.example" } })).json();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${org.id}/integrations`, payload: { provider: "google", mode: "sandbox" } });
    expect(res.statusCode).toBe(200);
    const integration = res.json();
    expect(integration).toMatchObject({ status: "connected", mode: "sandbox", provider: "google" });
    const tools = (await app.inject({ url: `/api/integrations/${integration.id}/tools` })).json();
    expect(tools.find((t: { name: string }) => t.name === "gws_reset_password")).toMatchObject({ risk: "destructive" });
    const dup = await app.inject({ method: "POST", url: `/api/orgs/${org.id}/integrations`, payload: { provider: "google", mode: "sandbox" } });
    expect(dup.statusCode).toBe(409);
  });

  it("validates live credentials and records connection errors", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret." }), { status: 401 })) as typeof fetch;
    const { app } = await makeApp(undefined, {}, fakeFetch);
    const org = (await app.inject({ method: "POST", url: "/api/orgs", payload: { name: "Contoso" } })).json();
    const missing = await app.inject({ method: "POST", url: `/api/orgs/${org.id}/integrations`, payload: { provider: "m365", mode: "live", config: { tenantId: "t" } } });
    expect(missing.statusCode).toBe(400);
    const bad = await app.inject({
      method: "POST",
      url: `/api/orgs/${org.id}/integrations`,
      payload: { provider: "m365", mode: "live", config: { tenantId: "t", clientId: "c", clientSecret: "s" } },
    });
    expect(bad.json()).toMatchObject({ status: "error", status_detail: expect.stringContaining("Invalid client secret") });
  });

  it("routes inbound email to the org by sender domain", async () => {
    const { app } = await makeApp();
    await app.inject({ method: "POST", url: "/api/orgs", payload: { name: "Contoso", domain: "contoso.example" } });
    const ok = await app.inject({
      method: "POST",
      url: "/api/intake",
      payload: { from: "megan@contoso.example", fromName: "Megan", subject: "Printer jam", body: "Help", autoRun: false },
    });
    expect(ok.json()).toMatchObject({ title: "Printer jam", requester_email: "megan@contoso.example", runId: null });
    const unknown = await app.inject({ method: "POST", url: "/api/intake", payload: { from: "x@elsewhere.example", subject: "Hi" } });
    expect(unknown.statusCode).toBe(422);
  });

  it("drives a ticket through approval and reveals the password to technicians with an audit entry", async () => {
    const llm = new ScriptedLlm(
      turn(text("Resetting."), toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })),
      turn(text("All set.")),
    );
    const { app, agent } = await makeApp(llm);
    await app.inject({ method: "POST", url: "/api/demo" });
    const contoso = (await app.inject({ url: "/api/orgs" })).json().find((o: { name: string }) => o.name === "Contoso Ltd");
    const created = (
      await app.inject({ method: "POST", url: "/api/tickets", payload: { orgId: contoso.id, title: "Reset Isaiah", description: "Please reset" } })
    ).json();
    await agent.settled(created.runId);

    const approvals = (await app.inject({ url: "/api/approvals" })).json();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ org_name: "Contoso Ltd", ticket: { number: created.number } });

    const headers = { "x-haley-user": "Jordan" };
    const approved = await app.inject({ method: "POST", url: `/api/actions/${approvals[0].id}/approve`, headers, payload: {} });
    expect(approved.statusCode).toBe(200);
    await agent.settled(created.runId);
    const again = await app.inject({ method: "POST", url: `/api/actions/${approvals[0].id}/approve`, headers, payload: {} });
    expect(again.statusCode).toBe(409);

    const detail = (await app.inject({ url: `/api/tickets/${created.id}` })).json();
    expect(detail.runs[0].status).toBe("completed");
    expect(detail.actions[0]).toMatchObject({ status: "executed", has_secrets: true, decided_by: "Jordan" });
    expect(JSON.stringify(detail)).not.toMatch(/"temporaryPassword":"[^[]/);

    const run = (await app.inject({ url: `/api/runs/${created.runId}` })).json();
    expect(run.transcript.map((s: { type: string }) => s.type)).toEqual(["context", "text", "tool_call", "tool_result", "text"]);

    const secret = (await app.inject({ method: "POST", url: `/api/actions/${approvals[0].id}/reveal`, headers })).json();
    expect(secret.temporaryPassword).toHaveLength(16);
    const audit = (await app.inject({ url: "/api/audit" })).json();
    expect(audit[0]).toMatchObject({ action: "secret.revealed", actor: "Jordan" });
    expect(audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(["action.approved", "action.executed"]));
  });

  it("does not save a comment when Haley can't be started on the ticket", async () => {
    const llm = new ScriptedLlm(turn(toolUse("m365_reset_password", { user: "isaiah.langer@contoso.example" })));
    const { app, agent } = await makeApp(llm);
    await app.inject({ method: "POST", url: "/api/demo" });
    const [ticket] = (await app.inject({ url: "/api/tickets" })).json();
    const run = (await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/run` })).json();
    await agent.settled(run.id);
    const before = (await app.inject({ url: `/api/tickets/${ticket.id}` })).json().events.length;
    const res = await app.inject({ method: "POST", url: `/api/tickets/${ticket.id}/comments`, payload: { body: "More info", runAgent: true } });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ url: `/api/tickets/${ticket.id}` })).json().events).toHaveLength(before);
  });

  it("supports knowledge base CRUD and search", async () => {
    const { app } = await makeApp();
    const a = (await app.inject({ method: "POST", url: "/api/kb", payload: { title: "VPN setup", body: "Install the client", tags: ["vpn"] } })).json();
    await app.inject({ method: "PUT", url: `/api/kb/${a.id}`, payload: { body: "Install the GlobalProtect client" } });
    const found = (await app.inject({ url: "/api/kb?q=globalprotect" })).json();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ org_name: "Global", tags: ["vpn"] });
    expect((await app.inject({ url: "/api/audit" })).json()[0]).toMatchObject({ action: "kb.updated", target: a.id });
    expect((await app.inject({ method: "DELETE", url: `/api/kb/${a.id}` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/kb/${a.id}` })).statusCode).toBe(404);
  });

  it("patches orgs without resetting omitted fields", async () => {
    const { app } = await makeApp();
    const org = (await app.inject({ method: "POST", url: "/api/orgs", payload: { name: "Acme", domain: "acme.example", autonomy: "autonomous", notes: "n" } })).json();
    const patched = (await app.inject({ method: "PATCH", url: `/api/orgs/${org.id}`, payload: { name: "Acme Corp" } })).json();
    expect(patched).toMatchObject({ name: "Acme Corp", domain: "acme.example", autonomy: "autonomous", notes: "n" });
    await app.inject({ method: "PATCH", url: `/api/orgs/${org.id}`, payload: { autonomy: "read_only" } });
    expect((await app.inject({ url: "/api/audit" })).json()[0]).toMatchObject({ action: "org.autonomy_changed", detail: { from: "autonomous", to: "read_only" } });
  });

  it("rejects invalid input with a readable 400", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "POST", url: "/api/orgs", payload: { name: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("name");
  });
});

describe("live clients", () => {
  it("Graph client authenticates with client credentials and builds OData filters", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "tok", expires_in: 3600 });
      return Response.json({ value: [{ id: "1", displayName: "O'Neil", userPrincipalName: "o@c.com", accountEnabled: true, assignedLicenses: [{ skuId: "s" }] }] });
    }) as typeof fetch;
    const api = new GraphM365Api({ tenantId: "tenant", clientId: "client", clientSecret: "secret" }, fakeFetch);
    const users = await api.listUsers("O'Neil");
    await api.listUsers();
    expect(users[0]).toMatchObject({ displayName: "O'Neil", licenses: ["s"] });
    expect(calls.filter((c) => c.url.includes("login.microsoftonline.com"))).toHaveLength(1); // token cached
    expect(String(calls[0].init?.body)).toContain("grant_type=client_credentials");
    expect(decodeURIComponent(calls[1].url)).toContain("startswith(displayName,'O''Neil')");
    expect((calls[1].init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("Google client signs a domain-wide delegation JWT", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = JSON.stringify({ client_email: "haley@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    let assertion = "";
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
        return Response.json({ access_token: "gtok", expires_in: 3600 });
      }
      return Response.json({ users: [{ id: "1", primaryEmail: "a@acme.example", name: { fullName: "A B" }, lastLoginTime: "1970-01-01T00:00:00.000Z" }] });
    }) as typeof fetch;
    const api = new LiveGoogleApi({ serviceAccountJson: key, adminEmail: "admin@acme.example" }, fakeFetch);
    const [user] = await api.listUsers();
    expect(user).toMatchObject({ primaryEmail: "a@acme.example", name: "A B", lastLoginTime: null });

    const [header, claims, signature] = assertion.split(".");
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(payload).toMatchObject({ iss: "haley@proj.iam.gserviceaccount.com", sub: "admin@acme.example" });
    expect(payload.scope).toContain("admin.directory.user");
    const valid = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url"));
    expect(valid).toBe(true);
  });
});
