import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

const rule = (approvers: string[]) => ({
  id: "r1",
  name: "Licences need a lead",
  enabled: true,
  tools: ["m365_assign_license"],
  risks: [],
  targets: [],
  departments: [],
  requesters: [],
  effect: "approve" as const,
  approvers,
  minAssurance: "directory" as const,
});

describe("technician directory", () => {
  it("adds, edits, finds and deactivates technicians, with an audit trail", async () => {
    const { app, store } = await makeApp();
    const created = await app.inject({ method: "POST", url: "/api/technicians", headers: { "x-haley-user": "Admin" }, payload: { name: " Dana Reyes ", email: "Dana@MSP.example" } });
    expect(created.statusCode).toBe(200);
    const dana = created.json();
    expect(dana).toMatchObject({ name: "Dana Reyes", email: "dana@msp.example", slack_user_id: null, active: true });

    // Names and emails are unique regardless of case.
    expect((await app.inject({ method: "POST", url: "/api/technicians", payload: { name: "dana reyes" } })).statusCode).toBe(409);
    const dupEmail = await app.inject({ method: "POST", url: "/api/technicians", payload: { name: "Someone", email: "DANA@msp.example" } });
    expect(dupEmail.statusCode).toBe(409);
    expect(dupEmail.json().error).toContain("email");

    const linked = await app.inject({ method: "PATCH", url: `/api/technicians/${dana.id}`, payload: { slackUserId: "U0DANA1", teamsAadId: "3F2504E0-4F89-11D3-9A0C-0305E82C3301" } });
    expect(linked.json()).toMatchObject({ slack_user_id: "U0DANA1", teams_aad_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" });
    expect((await app.inject({ method: "PATCH", url: `/api/technicians/${dana.id}`, payload: { slackUserId: "not-an-id" } })).statusCode).toBe(400);

    expect(store.findTechnician({ name: "DANA REYES" })?.id).toBe(dana.id);
    expect(store.findTechnician({ email: "dana@MSP.example" })?.id).toBe(dana.id);
    expect(store.findTechnician({ slackUserId: "U0DANA1" })?.id).toBe(dana.id);
    expect(store.findTechnician({ teamsAadId: "3F2504E0-4F89-11D3-9A0C-0305E82C3301" })?.id).toBe(dana.id);

    // Deactivating keeps the row (and the name in history) but stops matching.
    expect((await app.inject({ method: "DELETE", url: `/api/technicians/${dana.id}` })).json()).toMatchObject({ active: false });
    expect(store.findTechnician({ slackUserId: "U0DANA1" })).toBeNull();
    const again = await app.inject({ method: "POST", url: "/api/technicians", payload: { name: "Dana Reyes" } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain("Reactivate");
    expect((await app.inject({ method: "PATCH", url: `/api/technicians/${dana.id}`, payload: { active: true } })).json()).toMatchObject({ active: true });

    const actions = store.listAudit().filter((a) => a.target === dana.id).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["technician.created", "technician.updated", "technician.deactivated", "technician.reactivated"]));
    expect((await app.inject({ method: "PATCH", url: "/api/technicians/tech_missing", payload: { active: true } })).statusCode).toBe(404);
  });

  it("suggests names from sign-ins and rule approvers, and renaming updates the rules", async () => {
    const { app, store } = await makeApp();
    const org = store.createOrg({ name: "Contoso", settings: { policyRules: [rule(["priya", "Jordan"])] } });
    store.audit({ orgId: org.id, actor: "Sam Lee", action: "ticket.commented" });
    store.audit({ orgId: org.id, actor: "haley", action: "ticket.commented" });

    let list = (await app.inject({ method: "GET", url: "/api/technicians" })).json();
    expect(list.suggestions).toEqual(["Jordan", "priya", "Sam Lee"]);

    const priya = (await app.inject({ method: "POST", url: "/api/technicians", payload: { name: "priya" } })).json();
    list = (await app.inject({ method: "GET", url: "/api/technicians" })).json();
    expect(list.suggestions).toEqual(["Jordan", "Sam Lee"]);
    expect(list.technicians.map((t: { name: string }) => t.name)).toEqual(["priya"]);

    await app.inject({ method: "PATCH", url: `/api/technicians/${priya.id}`, payload: { name: "Priya Patel" } });
    expect(store.getOrg(org.id)!.settings.policyRules[0].approvers).toEqual(["Priya Patel", "Jordan"]);
    const audit = store.listAudit().find((a) => a.target === priya.id && a.action === "technician.updated")!;
    expect(audit.detail).toMatchObject({ from: "priya", to: "Priya Patel", rulesUpdated: 1 });
  });
});
