import { describe, expect, it } from "vitest";
import { AutotaskAdapter } from "../src/psa/autotask.js";
import { ConnectWiseAdapter } from "../src/psa/connectwise.js";
import { DynamicsAdapter } from "../src/psa/dynamics.js";
import { HaloAdapter } from "../src/psa/halopsa.js";
import { SyncroAdapter } from "../src/psa/syncro.js";
import type { ExternalComment, ExternalTicket, PsaAdapter, PsaAttachment, PsaConnection } from "../src/psa/types.js";
import { fakeFetch, firstUserText, makeApp, ScriptedLlm, text, turn } from "./helpers.js";

const bytes = (s: string) => new TextEncoder().encode(s);

/** A PSA with one ticket; the test adds comments and files. `content` null means too large; an Error fails the download. */
class FilePsa implements PsaAdapter {
  kind = "halopsa" as const;
  comments: ExternalComment[] = [];
  files: Array<PsaAttachment & { content: Uint8Array | null | Error }> = [];
  listFails = false;
  readonly downloads: string[] = [];
  private ticket = (): ExternalTicket => ({
    id: "ext1",
    number: "2001",
    subject: "Outlook crashes",
    description: "Outlook crashes when I open it",
    customerId: "c1",
    customerName: "Contoso",
    requesterEmail: "megan@contoso.example",
    requesterName: "Megan Bowen",
    status: "new",
    externalStatus: "New",
    priority: "normal",
    updatedAt: new Date().toISOString(),
    comments: this.comments,
  });
  test = async () => "ok";
  listCustomers = async () => [];
  listUpdatedTickets = async () => [this.ticket()];
  getTicket = async () => this.ticket();
  addComment = async () => `note-${Math.random()}`;
  setStatus = async () => {};
  createTicket = async () => ({ id: "x", number: "x" });
  listAttachments = async () => {
    if (this.listFails) throw new Error("HaloPSA GET /api/Attachment failed (403)");
    return this.files.map(({ content: _c, ...a }) => a);
  };
  getAttachment = async (_t: string, a: PsaAttachment) => {
    this.downloads.push(a.id);
    const f = this.files.find((x) => x.id === a.id)!;
    if (f.content instanceof Error) throw f.content;
    return f.content;
  };
}

const file = (id: string, filename: string, content: string | null | Error, extra: Partial<PsaAttachment> = {}) => ({
  id,
  filename,
  contentType: "text/plain",
  size: null,
  createdAt: "2026-10-01T10:00:00Z",
  fromCustomer: true,
  ...extra,
  content: typeof content === "string" ? bytes(content) : content,
});

async function setup(llm = new ScriptedLlm(turn(text("Looking into it.")))) {
  const fake = new FilePsa();
  const haley = await makeApp(llm, {}, undefined, undefined, () => fake);
  const { app, store } = haley;
  const org = store.createOrg({ name: "Contoso", domain: "contoso.example" });
  const connection = (await app.inject({ method: "POST", url: "/api/psa", payload: { kind: "halopsa", config: { instance: "msp.halopsa.com", clientId: "a", clientSecret: "b" }, options: { exportTickets: false, mirrorNotes: false } } })).json() as PsaConnection;
  store.updatePsaConnection(connection.id, { customerMap: { c1: org.id } });
  return { ...haley, fake, org, connection, llm };
}

describe("attachments from the PSA", () => {
  it("is on for new connections and off for older ones until turned on", async () => {
    const { app, store, connection } = await setup();
    expect(connection.options.importAttachments).toBe(true);
    const older = store.createPsaConnection({ kind: "syncro", name: "Older", config: { subdomain: "x", apiKey: "y" }, options: {} });
    expect(store.getPsaConnection(older.id)!.options.importAttachments).toBeFalsy();
    await app.close();
  });

  it("gives Haley the customer's files on a new ticket, and keeps technicians' files out of her run", async () => {
    const { app, store, psa, agent, fake, connection, llm } = await setup();
    fake.files = [
      file("f1", "error.log", "0x80070005 access denied"),
      file("f2", "tech-notes.txt", "internal: try safe mode", { fromCustomer: false }),
    ];
    const result = await psa.sync(connection.id);
    expect(result).toMatchObject({ imported: 1, attachmentsImported: 2 });
    const ticket = store.listTickets({}).find((t) => t.title === "Outlook crashes")!;
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);
    const intro = firstUserText(llm.requests[0]);
    expect(intro).toContain('<attachment name="error.log" untrusted="true">');
    expect(intro).toContain("0x80070005 access denied");
    expect(intro).not.toContain("try safe mode");

    const files = store.listAttachments(ticket.id);
    expect(files.map((f) => [f.filename, f.event_id === null])).toEqual([
      ["error.log", true],
      ["tech-notes.txt", false],
    ]);
    const note = store.listTicketEvents(ticket.id).find((e) => e.meta.technicianFiles)!;
    expect(note.body).toBe("Files added in HaloPSA: tech-notes.txt");
    expect(store.getTicketLink(ticket.id, connection.id)!.seen_attachment_ids).toEqual(["f1", "f2"]);

    // Nothing is downloaded twice.
    await psa.sync(connection.id);
    expect(fake.downloads).toEqual(["f1", "f2"]);
    await app.close();
  });

  it("links a customer's new file to their new message, or to a message of its own", async () => {
    const llm = new ScriptedLlm(turn(text("Looking.")), turn(text("Thanks.")), turn(text("Got it.")));
    const { app, store, psa, agent, fake, connection } = await setup(llm);
    await psa.sync(connection.id);
    const ticket = store.listTickets({}).find((t) => t.title === "Outlook crashes")!;
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);

    fake.comments = [{ id: "c1", body: "Here's the error", author: "Megan Bowen", fromCustomer: true, public: true, createdAt: "2026-10-01T11:00:00Z" }];
    fake.files = [file("f1", "screen.txt", "Error 42", { commentId: "c1", fromCustomer: false })];
    await psa.sync(connection.id);
    const comment = store.listTicketEvents(ticket.id).find((e) => e.body === "Here's the error")!;
    // The comment's author decides whose file it is.
    expect(store.listAttachments(ticket.id).find((a) => a.filename === "screen.txt")!.event_id).toBe(comment.id);
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);

    fake.files.push(file("f2", "more.txt", "Error 43"));
    await psa.sync(connection.id);
    const own = store.listTicketEvents(ticket.id).find((e) => e.body.startsWith("(Sent 1 attachment in HaloPSA: more.txt)"))!;
    expect(store.listAttachments(ticket.id).find((a) => a.filename === "more.txt")!.event_id).toBe(own.id);
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);
    await app.close();
  });

  it("lists files it won't download, keeps going when listing fails, and stays within the caps", async () => {
    const { app, store, psa, agent, fake, connection } = await setup(new ScriptedLlm(turn(text("Looking."))));
    fake.files = [
      file("big", "dump.bin", null),
      file("broken", "broken.txt", new Error("HaloPSA GET /api/Attachment/broken failed (500)")),
      ...Array.from({ length: 6 }, (_, i) => file(`n${i}`, `note-${i}.txt`, `note ${i}`)),
    ];
    const first = await psa.sync(connection.id);
    const ticket = store.listTickets({}).find((t) => t.title === "Outlook crashes")!;
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);
    expect(first.attachmentsImported).toBe(5);
    const listed = store.listAttachments(ticket.id);
    expect(listed.find((a) => a.filename === "dump.bin")).toMatchObject({ kind: "other", note: "Not downloaded: over 10 MB." });
    expect(listed.find((a) => a.filename === "broken.txt")!.note).toContain("failed (500)");

    // The rest come on the next sync.
    expect((await psa.sync(connection.id)).attachmentsImported).toBe(3);
    expect(store.getTicketLink(ticket.id, connection.id)!.seen_attachment_ids).toHaveLength(8);

    fake.listFails = true;
    fake.comments = [{ id: "c9", body: "Any news?", author: "Megan Bowen", fromCustomer: true, public: true, createdAt: "2026-10-01T12:00:00Z" }];
    const failed = await psa.sync(connection.id);
    expect(failed.errors).toEqual(["Attachments on #2001: HaloPSA GET /api/Attachment failed (403)"]);
    expect(failed.commentsImported).toBe(1);
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);
    await app.close();
  });

  it("imports nothing with the option off", async () => {
    const { app, store, psa, agent, fake, connection } = await setup();
    await app.inject({ method: "PATCH", url: `/api/psa/${connection.id}`, payload: { options: { importAttachments: false } } });
    fake.files = [file("f1", "error.log", "x")];
    await psa.sync(connection.id);
    const ticket = store.listTickets({}).find((t) => t.title === "Outlook crashes")!;
    await agent.settled(store.listRuns({ ticketId: ticket.id })[0].id);
    expect(store.listAttachments(ticket.id)).toEqual([]);
    expect(fake.downloads).toEqual([]);
    await app.close();
  });
});

describe("attachments in each PSA", () => {
  it("ConnectWise: ticket documents, downloaded with the API member's credentials", async () => {
    const net = fakeFetch([
      [/\/system\/documents\?recordType=Ticket&recordId=5/, () => [{ id: 70, fileName: "error.png", contentType: "image/png", fileSize: 4, _info: { dateEntered: "2026-10-01T10:00:00Z" } }]],
      [/\/system\/documents\/70\/download$/, () => new Response(bytes("PNG!"), { status: 200 })],
    ]);
    const cw = new ConnectWiseAdapter({ site: "api-na.myconnectwise.net", companyId: "a", publicKey: "b", privateKey: "c", clientId: "d", board: "B" }, net.impl);
    const [doc] = await cw.listAttachments("5");
    expect(doc).toMatchObject({ id: "70", filename: "error.png", size: 4, fromCustomer: true });
    expect(new TextDecoder().decode((await cw.getAttachment("5", doc, 100))!)).toBe("PNG!");
    expect(net.calls[1].headers.authorization).toMatch(/^Basic /);
    expect(await cw.getAttachment("5", doc, 2)).toBeNull();
  });

  it("HaloPSA: attachments with their action, as base64", async () => {
    const net = fakeFetch([
      [/\/auth\/token/, () => ({ access_token: "t", expires_in: 3600 })],
      [/\/api\/Attachment\?ticket_id=9$/, () => ({ attachments: [{ id: 3, filename: "log.txt", filesize: 5, datecreated: "2026-10-01T10:00:00", action_id: 44 }] })],
      [/\/api\/Attachment\/3\?includedetails=true$/, () => ({ id: 3, data_base64: Buffer.from("hello").toString("base64") })],
    ]);
    const halo = new HaloAdapter({ instance: "https://msp.halopsa.com", clientId: "a", clientSecret: "b" }, net.impl);
    const [a] = await halo.listAttachments("9");
    expect(a).toMatchObject({ id: "3", filename: "log.txt", commentId: "44" });
    expect(new TextDecoder().decode((await halo.getAttachment("9", a, 100))!)).toBe("hello");
  });

  it("Syncro: pre-signed links, only from Syncro's storage and without credentials", async () => {
    const net = fakeFetch([
      [/\/api\/v1\/tickets\/3$/, () => ({ ticket: { id: 3, attachments: [{ id: 8, file_name: "pic.jpg", file: { url: "https://syncro-files.s3.amazonaws.com/a/pic.jpg?sig=x" } }, { id: 9, file_name: "evil.txt", file: { url: "https://evil.example/x" } }] } })],
      [/s3\.amazonaws\.com\/a\/pic\.jpg/, () => new Response(bytes("JPEG"), { status: 200 })],
    ]);
    const syncro = new SyncroAdapter({ subdomain: "msp", apiKey: "secret-token" }, net.impl);
    const [pic, evil] = await syncro.listAttachments("3");
    expect(new TextDecoder().decode((await syncro.getAttachment("3", pic, 100))!)).toBe("JPEG");
    expect(net.calls.at(-1)!.headers.authorization).toBeUndefined();
    await expect(syncro.getAttachment("3", evil, 100)).rejects.toThrow("Not downloading a Syncro file from evil.example");
  });

  it("Autotask: file attachments (a contact's are the customer's), as base64", async () => {
    const net = fakeFetch([
      [/\/TicketAttachments\/query$/, () => ({ items: [{ id: 11, parentID: 7, title: "shot", fullPath: "C:\\\\Users\\\\shot.png", attachmentType: "FILE_ATTACHMENT", fileSize: 3, attachDate: "2026-10-01T10:00:00Z", attachedByContactID: 55 }, { id: 12, attachmentType: "URL", title: "link" }], pageDetails: {} })],
      [/\/Tickets\/7\/Attachments\/11$/, () => ({ items: [{ id: 11, data: Buffer.from("abc").toString("base64") }] })],
    ]);
    const at = new AutotaskAdapter({ username: "u", secret: "s", integrationCode: "i", zoneUrl: "https://webservices2.autotask.net/atservicesrest/v1.0" }, net.impl);
    const files = await at.listAttachments("7");
    expect(files).toEqual([expect.objectContaining({ id: "11", filename: "shot.png", fromCustomer: true })]);
    expect(new TextDecoder().decode((await at.getAttachment("7", files[0], 100))!)).toBe("abc");
  });

  it("Dynamics: note documents (technicians') and incoming email attachments (the customer's)", async () => {
    const CASE = "11111111-1111-1111-1111-111111111111";
    const NOTE = "22222222-2222-2222-2222-222222222222";
    const EMAIL = "33333333-3333-3333-3333-333333333333";
    const FILE = "44444444-4444-4444-4444-444444444444";
    const net = fakeFetch([
      [/login\.microsoftonline\.com/, () => ({ access_token: "t", expires_in: 3600 })],
      [/\/annotations\?\$select=annotationid,filename/, () => ({ value: [{ annotationid: NOTE, filename: "fix.txt", mimetype: "text/plain", filesize: 3 }] })],
      [/\/emails\?\$select=activityid&/, () => ({ value: [{ activityid: EMAIL }] })],
      [/\/activitymimeattachments\?/, () => ({ value: [{ activitymimeattachmentid: FILE, filename: "screen.png", mimetype: "image/png", filesize: 4 }] })],
      [/\/activitymimeattachments\(4444/, () => ({ body: Buffer.from("PNG!").toString("base64") })],
    ]);
    const dyn = new DynamicsAdapter({ orgUrl: "https://contoso.crm.dynamics.com", tenantId: "t", clientId: "c", clientSecret: "s" }, net.impl);
    const files = await dyn.listAttachments(CASE);
    expect(files.map((f) => [f.id, f.fromCustomer, f.commentId ?? null])).toEqual([
      [`note:${NOTE}`, false, null],
      [`email:${FILE}`, true, `email:${EMAIL}`],
    ]);
    expect(new TextDecoder().decode((await dyn.getAttachment(CASE, files[1], 100))!)).toBe("PNG!");
  });
});
