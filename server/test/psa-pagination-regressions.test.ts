import { describe, expect, it } from "vitest";
import { AutotaskAdapter } from "../src/psa/autotask.js";
import { ConnectWiseAdapter } from "../src/psa/connectwise.js";
import { HaloAdapter } from "../src/psa/halopsa.js";
import { fakeFetch } from "./helpers.js";

const ZONE = "https://webservices5.autotask.net/ATServicesRest/V1.0";
const autotask = (fetchImpl: typeof fetch) => new AutotaskAdapter({ username: "u", secret: "secret", integrationCode: "i", zoneUrl: ZONE }, fetchImpl);
const connectwise = (fetchImpl: typeof fetch) => new ConnectWiseAdapter({ site: "api-na.myconnectwise.net", companyId: "c", publicKey: "p", privateKey: "secret", clientId: "i", board: "Help Desk" }, fetchImpl);
const halo = (fetchImpl: typeof fetch) => new HaloAdapter({ instance: "msp.halopsa.com", clientId: "c", clientSecret: "secret" }, fetchImpl);

describe("PSA credential destinations", () => {
  // Model fetch's default 307 behavior: it sends the original credentials/body to Location.
  const redirectedFetch = (tokenRedirect = false) => {
    const destinations: string[] = [];
    const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      destinations.push(url);
      if (url.includes("/auth/token") && !tokenRedirect) return Response.json({ access_token: "t" });
      if (init.redirect !== "manual" && init.redirect !== "error") {
        destinations.push("https://untrusted.example/receiver");
        return Response.json(url.includes("/auth/token") ? { access_token: "stolen" } : []);
      }
      return new Response(null, { status: 307, headers: { location: "https://untrusted.example/receiver" } });
    }) as typeof fetch;
    return { impl, destinations };
  };

  it.each(["autotask", "connectwise", "halo"])("doesn't follow an authenticated %s redirect", async (kind) => {
    const net = redirectedFetch();
    const adapter = kind === "autotask" ? autotask(net.impl) : kind === "connectwise" ? connectwise(net.impl) : halo(net.impl);
    await expect(adapter.listCustomers()).rejects.toThrow();
    expect(net.destinations).not.toContain("https://untrusted.example/receiver");
  });

  it("doesn't forward a Halo OAuth client secret on a token endpoint redirect", async () => {
    const net = redirectedFetch(true);
    await expect(halo(net.impl).listCustomers()).rejects.toThrow();
    expect(net.destinations).toEqual(["https://msp.halopsa.com/auth/token"]);
  });

  it("rejects Autotask next-page links outside its configured API before sending credentials", async () => {
    const net = fakeFetch([
      [/Companies\/query$/, () => ({ items: [{ id: 1 }], pageDetails: { nextPageUrl: "https://untrusted.example/receiver" } })],
      [/untrusted/, () => ({ items: [] })],
    ]);
    await expect(autotask(net.impl).listCustomers()).rejects.toThrow(/page|base|URL/i);
    expect(net.calls).toHaveLength(1);
  });

  it("follows a same-API Autotask next-page link", async () => {
    const net = fakeFetch([
      [/Companies\/query$/, () => ({ items: [{ id: 1 }], pageDetails: { nextPageUrl: `${ZONE}/Companies/query?next=2` } })],
      [/next=2$/, () => ({ items: [{ id: 2 }] })],
    ]);
    expect((await autotask(net.impl).listCustomers()).map((c) => c.id)).toEqual(["1", "2"]);
  });
});

describe("PSA incomplete collections", () => {
  it("rejects an Autotask query with another page after the page limit", async () => {
    const net = fakeFetch([[/Companies\/query/, () => ({ items: [{ id: 1 }], pageDetails: { nextPageUrl: `${ZONE}/Companies/query?next=2` } })]]);
    await expect(autotask(net.impl).listCustomers()).rejects.toThrow(/page limit|incomplete/i);
    expect(net.calls).toHaveLength(40);
  });

  it("rejects a full ConnectWise collection at the page limit", async () => {
    const net = fakeFetch([[/company\/companies/, () => Array.from({ length: 100 }, (_, id) => ({ id }))]]);
    await expect(connectwise(net.impl).listCustomers()).rejects.toThrow(/page limit|incomplete/i);
    expect(net.calls).toHaveLength(41);
  });

  it("rejects a Halo collection known to extend past the page limit", async () => {
    const net = fakeFetch([
      [/auth\/token/, () => ({ access_token: "t" })],
      [/api\/Client/, () => ({ record_count: 4001, clients: Array.from({ length: 100 }, (_, id) => ({ id })) })],
    ]);
    await expect(halo(net.impl).listCustomers()).rejects.toThrow(/page limit|incomplete/i);
    expect(net.calls.filter((c) => c.url.includes("/api/Client"))).toHaveLength(40);
  });

  it("allows an exactly-full ConnectWise collection when the probe page is empty", async () => {
    const net = fakeFetch([[/company\/companies/, (call) => new URL(call.url).searchParams.get("page") === "41"
      ? [] : Array.from({ length: 100 }, (_, id) => ({ id }))]]);
    expect(await connectwise(net.impl).listCustomers()).toHaveLength(4000);
    expect(net.calls).toHaveLength(41);
  });

  it("allows an exactly-full Halo collection with a known total", async () => {
    const net = fakeFetch([
      [/auth\/token/, () => ({ access_token: "t" })],
      [/api\/Client/, () => ({ record_count: 4000, clients: Array.from({ length: 100 }, (_, id) => ({ id })) })],
    ]);
    expect(await halo(net.impl).listCustomers()).toHaveLength(4000);
    expect(net.calls.filter((call) => call.url.includes("/api/Client"))).toHaveLength(40);
  });

  it("allows an exactly-full Halo collection without a total when the probe page is empty", async () => {
    const net = fakeFetch([
      [/auth\/token/, () => ({ access_token: "t" })],
      [/api\/Client/, (call) => ({ clients: new URL(call.url).searchParams.get("page_no") === "41"
        ? [] : Array.from({ length: 100 }, (_, id) => ({ id })) })],
    ]);
    expect(await halo(net.impl).listCustomers()).toHaveLength(4000);
    expect(net.calls.filter((call) => call.url.includes("/api/Client"))).toHaveLength(41);
  });
});
