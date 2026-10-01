import { describe, it, expect, afterAll } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import { pool } from "../server/storage";
import { describeFetchFailure, probeBroker, mintViaBroker, executeViaBroker } from "../server/broker-registry";
import { createHeartbeatLog as authHeartbeatLog } from "../vox_eval_agentd/auth-session-broker";
import { createHeartbeatLog as restHeartbeatLog } from "../vox_rest_broker/rest-broker";

// #129: a broker whose advertised URL Core couldn't reach looked healthy (its
// heartbeats prove only broker→Core) and every mint failed as
// "target login failed: fetch failed". Core now probes the advertised URL,
// shows the answer on the Brokers page, and names the failure class.

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const d = process.env.DATABASE_URL ? describe : describe.skip;
const fetchError = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code, message: `getaddrinfo ${code} x` } });

/** A real port nothing listens on: open a server, note its port, close it. */
async function closedPort(): Promise<number> {
  const s = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

describe("#129 a failed broker call says what failed", () => {
  it("names the transport failure instead of a bare 'fetch failed'", () => {
    expect(describeFetchFailure(fetchError("ENOTFOUND"))).toMatch(/hostname doesn't resolve from Core \(ENOTFOUND\)/);
    expect(describeFetchFailure(fetchError("EAI_AGAIN"))).toMatch(/hostname doesn't resolve/);
    expect(describeFetchFailure(fetchError("ECONNREFUSED"))).toMatch(/connection refused/);
    expect(describeFetchFailure(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe("no answer in time");
  });

  it("probes a real address: refused, unreachable name, and a healthy broker", async () => {
    expect(await probeBroker(`http://127.0.0.1:${await closedPort()}`)).toMatch(/connection refused/);
    expect(await probeBroker("http://no-such-broker.invalid:8200")).toMatch(/hostname doesn't resolve/);
    const ok = http.createServer((req, res) => {
      res.writeHead(req.url === "/health" ? 200 : 404).end("{}");
    }).listen(0, "127.0.0.1");
    await new Promise((r) => ok.once("listening", r));
    const base = `http://127.0.0.1:${(ok.address() as AddressInfo).port}`;
    try {
      expect(await probeBroker(base)).toBeNull();
      expect(await probeBroker(`${base}/nope`)).toBe("GET /health answered HTTP 404");
    } finally {
      ok.close();
    }
  });

  const target = { id: 1, url: "http://broker.test", mintSecret: "s" };
  const req = { platformId: "p", email: "ann@agora.io", password: "hunter2-pass" };
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("a mint names its class: Core couldn't reach the broker / the broker refused Core / the login failed", async () => {
    const throws = (async () => { throw fetchError("ENOTFOUND"); }) as unknown as typeof fetch;
    await expect(mintViaBroker(target, req, throws)).rejects.toThrow(/^Core couldn't reach the session broker: its hostname doesn't resolve/);
    await expect(mintViaBroker(target, req, answer(401, { error: "unauthorized" }))).rejects.toThrow(/session broker refused Core \(HTTP 401\)/);
    await expect(mintViaBroker(target, req, answer(502, { error: "Step 1 failed: platform.setup" }))).rejects.toThrow(/^target login failed: Step 1 failed/);
  });

  it("a REST call that can't reach its broker says so", async () => {
    const throws = (async () => { throw fetchError("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(executeViaBroker(target, { method: "GET", url: "https://example.com" }, [], throws))
      .rejects.toThrow(/^Core couldn't reach the REST broker: connection refused/);
  });
});

describe("#129 a broker's heartbeat failures are logged — once, not every minute", () => {
  for (const [name, make, tag] of [["auth-session", authHeartbeatLog, "Broker"], ["REST", restHeartbeatLog, "RestBroker"]] as const) {
    it(`${name} broker: on failing, on a changed reason, and on recovery`, () => {
      const lines: string[] = [];
      const note = make((l) => lines.push(l));
      note(null);                         // healthy: nothing
      note("fetch failed (ENOTFOUND)");   // starts failing
      note("fetch failed (ENOTFOUND)");   // still failing, same reason: nothing
      note("Core answered HTTP 401 (registration token revoked?)"); // new reason
      note(null);                         // recovered
      note(null);
      expect(lines).toEqual([
        `[${tag}] heartbeat to Core failing: fetch failed (ENOTFOUND)`,
        `[${tag}] heartbeat to Core failing: Core answered HTTP 401 (registration token revoked?)`,
        `[${tag}] heartbeat to Core recovered`,
      ]);
    });
  }
});

d("#129 Core probes a broker as it registers, and the Brokers page shows the answer", () => {
  const tokenIds: number[] = [];
  const servers: http.Server[] = [];
  let admin = "";

  afterAll(async () => {
    for (const s of servers) s.close();
    if (tokenIds.length) {
      await pool.query("DELETE FROM brokers WHERE token_id = ANY($1)", [tokenIds]);
      await pool.query("DELETE FROM broker_registration_tokens WHERE id = ANY($1)", [tokenIds]);
    }
  });

  async function register(url: string): Promise<number> {
    if (!admin) {
      admin = ((await fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@vox.local", password: "admin123456" }),
      })).headers.get("set-cookie") || "").split(";")[0];
    }
    const tok = await (await fetch(`${BASE_URL}/api/admin/broker-tokens`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: admin }, body: JSON.stringify({ name: `reach-${Date.now()}-${Math.random()}` }),
    })).json();
    tokenIds.push(tok.id);
    const reg = await fetch(`${BASE_URL}/api/brokers/register`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok.token}` },
      body: JSON.stringify({ name: "reach-test", brokerType: "auth-session", url }),
    });
    expect(reg.status).toBe(200);
    return (await reg.json()).brokerId;
  }

  async function listed(id: number) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const rows = await (await fetch(`${BASE_URL}/api/admin/brokers`, { headers: { Cookie: admin } })).json();
      const row = rows.find((b: { id: number }) => b.id === id);
      if (row?.reachabilityCheckedAt || Date.now() > deadline) return row;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  it("an advertised URL Core can't resolve is flagged, with the reason", async () => {
    // The production failure: an advertised hostname Docker's DNS doesn't know.
    const id = await register("http://tte9qzeqxt47w9afimmsrfy8:8200"); // the app UUID prod advertised
    const row = await listed(id);
    expect(row.reachabilityCheckedAt).not.toBeNull();
    expect(row.reachabilityError).toMatch(/hostname doesn't resolve/);
  });

  it("a broker Core can reach is marked reachable", async () => {
    const s = http.createServer((req, res) => res.writeHead(req.url === "/health" ? 200 : 404).end("{}")).listen(0, "127.0.0.1");
    servers.push(s);
    await new Promise((r) => s.once("listening", r));
    const id = await register(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
    const row = await listed(id);
    expect(row.reachabilityCheckedAt).not.toBeNull();
    expect(row.reachabilityError).toBeNull();
  });
});
