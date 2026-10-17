import { describe, it, expect, afterAll } from "vitest";
import http from "http";
import net from "net";
import type { AddressInfo } from "net";
import { describeFetchError, describeRequest, describeHttpFailure, createFailureLog, sanitizeRemoteText, sendWithRetry } from "../vox_eval_agentd/net-errors";

// The eval agent logged "[Daemon] Error fetching jobs: fetch failed" — undici's
// bare message, with the real reason (DNS, refused, reset, timeout, TLS) hidden
// in `cause`, and nothing about which call or which server. These drive real
// sockets to check the words an operator now sees.

const servers: Array<http.Server | net.Server> = [];
afterAll(() => servers.forEach((s) => s.close()));

async function listen<T extends http.Server | net.Server>(s: T): Promise<number> {
  servers.push(s);
  s.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  return (s.address() as AddressInfo).port;
}
async function closedPort(): Promise<number> {
  const s = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}
const failure = async (url: string, init?: RequestInit) => {
  try { await fetch(url, init); } catch (e) { return describeFetchError(e); }
  throw new Error("expected the fetch to fail");
};

describe("why a call to Vox failed, from real sockets", () => {
  it("nothing listening: connection refused", async () => {
    expect(await failure(`http://127.0.0.1:${await closedPort()}/api/eval-agent/jobs`))
      .toMatch(/^connection refused \(the server is down or restarting\) — connect ECONNREFUSED 127\.0\.0\.1:\d+ \(ECONNREFUSED\)$/);
  });

  it("a hostname that doesn't resolve", async () => {
    expect(await failure("http://vox-no-such-host.invalid/api/eval-agent/jobs")).toMatch(/hostname doesn't resolve|DNS lookup failed/);
  });

  it("the server drops the connection mid-request", async () => {
    const port = await listen(net.createServer((sock) => sock.destroy()));
    expect(await failure(`http://127.0.0.1:${port}/`)).toMatch(/connection was dropped|socket/i);
  });

  it("the server never answers in time", async () => {
    const port = await listen(net.createServer(() => { /* accept, say nothing */ }));
    expect(await failure(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(200) })).toBe("no answer in time (request timed out)");
  });

  it("names the request without its query (the lease id)", () => {
    expect(describeRequest("post", "https://vox.example/api/eval-agent/jobs/7/storage-config?leaseId=SECRET"))
      .toBe("POST https://vox.example/api/eval-agent/jobs/7/storage-config");
    expect(describeRequest(undefined, "https://vox.example/api/eval-agent/jobs")).toBe("GET https://vox.example/api/eval-agent/jobs");
    // Nor credentials in the URL (#246 review).
    expect(describeRequest("get", "https://ops:hunter2@vox.example:8443/api/eval-agent/jobs?leaseId=X"))
      .toBe("GET https://vox.example:8443/api/eval-agent/jobs");
  });
});

describe("an HTTP error says Vox's own reason", () => {
  it("quotes { error } from Vox, and releases the response (its body is consumed)", async () => {
    const port = await listen(http.createServer((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "superseded lease" }));
    }));
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await describeHttpFailure(res)).toBe("HTTP 403 Forbidden: superseded lease");
    expect(res.bodyUsed).toBe(true); // read and released, not left holding the connection
  });

  it("a non-JSON body (a proxy's error page) is quoted, collapsed and capped", async () => {
    const port = await listen(http.createServer((_req, res) => {
      res.writeHead(502).end(`<html>\n  <h1>Bad Gateway</h1>\n${"x".repeat(1000)}</html>`);
    }));
    const said = await describeHttpFailure(await fetch(`http://127.0.0.1:${port}/`));
    expect(said.startsWith("HTTP 502 Bad Gateway: <html> <h1>Bad Gateway</h1>")).toBe(true);
    expect(said.length).toBeLessThan(340);
  });
});

describe("the 10 s job poll logs an outage once, and its recovery", () => {
  it("first failure, a changed reason, then one recovery line with the count", () => {
    const errors: string[] = [];
    const infos: string[] = [];
    const note = createFailureLog("Job polling", { error: (l) => errors.push(l), info: (l) => infos.push(l) });
    note(null);
    for (let i = 0; i < 5; i++) note("GET https://vox.example/api/eval-agent/jobs failed: connection refused (ECONNREFUSED)");
    note("Vox answered HTTP 503 Service Unavailable: starting up");
    note(null);
    note(null);
    expect(errors).toEqual([
      "[Daemon] Job polling failing: GET https://vox.example/api/eval-agent/jobs failed: connection refused (ECONNREFUSED)",
      "[Daemon] Job polling failing: Vox answered HTTP 503 Service Unavailable: starting up",
    ]);
    expect(infos).toEqual(["[Daemon] Job polling recovered after 6 failed attempts"]);
  });
});

describe("#246 review: error bodies are read bounded and logged safely", () => {
  it("an error body that never ends doesn't hang the call: the first 4 KB, then the rest is cancelled", async () => {
    const port = await listen(http.createServer((_req, res) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.write("x".repeat(8192)); // …and never res.end()
    }));
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const started = Date.now();
    const said = await describeHttpFailure(res);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(said).toMatch(/^HTTP 502 Bad Gateway: x{300}$/);
  });

  it("strips terminal escape sequences and control characters a server could send", () => {
    expect(sanitizeRemoteText("\x1b[2J\x1b[31mforged\x1b[0m \x1b]0;title\x07line\rcarriage\x00null"))
      .toBe("forged linecarriagenull");
  });
});

describe("#246 review: the artifact report retries only what a retry can fix", () => {
  const answer = (status: number) => new Response(JSON.stringify({ error: `status ${status}` }), { status });
  it("a 5xx is retried, and success ends it", async () => {
    const seen: number[] = [503, 200];
    let calls = 0;
    expect(await sendWithRetry(async () => answer(seen[calls++]), { delayMs: 0 })).toBeNull();
    expect(calls).toBe(2);
  });
  it("a 4xx is final — one attempt", async () => {
    let calls = 0;
    expect(await sendWithRetry(async () => { calls++; return answer(403); }, { delayMs: 0 })).toBe("HTTP 403: status 403");
    expect(calls).toBe(1);
  });
  it("a timeout is not retried: the server may still be handling the first attempt", async () => {
    let calls = 0;
    const timedOut = Object.assign(new Error("POST https://vox.example/x failed: no answer in time (request timed out)"), {
      cause: Object.assign(new Error("t"), { name: "TimeoutError" }),
    });
    const reason = await sendWithRetry(async () => { calls++; throw timedOut; }, { delayMs: 0 });
    expect(calls).toBe(1);
    expect(reason).toMatch(/not retried: the server may still be handling it/);
  });

  it("a body that drips slower than it fills 4 KB is cut off by the request's timeout, not waited on", async () => {
    const port = await listen(http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.write("slow"); // a few bytes, then nothing — never 4 KB, never the end
    }));
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) });
    const started = Date.now();
    expect(await describeHttpFailure(res)).toBe("HTTP 503 Service Unavailable: slow");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a network failure is retried until the attempts run out, and says so", async () => {
    let calls = 0;
    const reason = await sendWithRetry(async () => { calls++; throw new Error("POST https://vox.example/x failed: connection refused"); }, { delayMs: 0 });
    expect(calls).toBe(3);
    expect(reason).toBe("POST https://vox.example/x failed: connection refused (after 3 attempts)");
  });
});
