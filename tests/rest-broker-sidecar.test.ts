import { describe, it, expect, afterEach } from "vitest";
import { assertSafeTarget, executeTarget } from "../vox_rest_broker/rest-broker";

// Unit tests for the REST broker sidecar's guards and execute handler
// (design 2026-09-21 §5). No Docker, no network — injected fetch only.

afterEach(() => { delete process.env.REST_BROKER_ALLOW_PRIVATE; });

describe("assertSafeTarget (SSRF guard)", () => {
  const bad = (url: string) => expect(() => assertSafeTarget(url)).toThrow();
  const good = (url: string) => expect(() => assertSafeTarget(url)).not.toThrow();

  it("rejects loopback, private, link-local, and reserved targets", () => {
    bad("http://localhost:8080/x");
    bad("http://127.0.0.1/x");
    bad("https://10.1.2.3/x");
    bad("https://172.16.0.9/x");
    bad("https://192.168.1.1/x");
    bad("https://169.254.169.254/latest/meta-data"); // cloud metadata
    bad("https://0.0.0.0/x");
    bad("ftp://example.com/x");
    bad("not a url");
  });

  it("allows public DNS names and public IPs", () => {
    good("https://api.example.com/v1/calls");
    good("http://api.example.com/v1/calls");
    good("https://8.8.8.8/x");
  });

  it("REST_BROKER_ALLOW_PRIVATE=1 opens private targets (dev)", () => {
    process.env.REST_BROKER_ALLOW_PRIVATE = "1";
    good("http://localhost:9000/x");
    good("http://127.0.0.1:9000/x");
  });
});

describe("executeTarget", () => {
  it("performs the request and returns capped status+excerpt", async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url, init });
      return new Response(`ok ${"y".repeat(5000)}`, { status: 201 });
    }) as any;
    const out = await executeTarget(
      { method: "POST", url: "https://t.example/x", headers: { Authorization: "Bearer k" }, body: { a: 1 } },
      fetchImpl,
    );
    expect(out.code).toBe(200);
    expect(out.payload.status).toBe(201);
    expect((out.payload.bodyExcerpt as string).length).toBeLessThanOrEqual(2048);
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.headers["content-type"]).toBe("application/json");
    expect(calls[0].init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("400 on unsafe target or bad method; 502 on fetch failure", async () => {
    const out1 = await executeTarget({ method: "POST", url: "http://127.0.0.1/x" });
    expect(out1.code).toBe(400);
    const out2 = await executeTarget({ method: "BREW" as any, url: "https://t.example/x" });
    expect(out2.code).toBe(400);
    const failing = (async () => { throw new Error("ECONNREFUSED somewhere"); }) as any;
    const out3 = await executeTarget({ method: "GET", url: "https://t.example/x" }, failing);
    expect(out3.code).toBe(502);
    expect(String(out3.payload.error)).toContain("target fetch failed");
  });

  it("a redirect is returned as the status, never followed", async () => {
    const fetchImpl = (async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1/evil" } })) as any;
    const out = await executeTarget({ method: "GET", url: "https://t.example/x" }, fetchImpl);
    expect(out.code).toBe(200);
    expect(out.payload.status).toBe(302);
  });
});
