import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createKeylessLimiter, keylessPerMinute, DEFAULT_KEYLESS_PER_MINUTE } from "../server/public-rate-limit";

// Keyless requests to the public v1 API are limited per client IP; a request
// with an API key (or a session) isn't counted. The real middleware on a small
// app that trusts the proxy as production does, so X-Forwarded-For stands in
// for different callers.

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function app(opts: { enabled: boolean; perMinute: number }): Promise<string> {
  const a = express();
  a.set("trust proxy", 1);
  // Stand-in for authenticateApiKey: a request with a key header is identified.
  a.use((req, _res, next) => {
    if (req.headers.authorization === "Bearer vox_live_test") (req as { apiKeyUser?: unknown }).apiKeyUser = { id: 1 };
    next();
  });
  a.use("/api/v1", createKeylessLimiter(opts));
  a.get("/api/v1/metrics/realtime", (_req, res) => res.json({ ok: true }));
  a.get("/api/v1/openapi.json", (_req, res) => res.json({ openapi: "3" }));
  const s = a.listen(0, "127.0.0.1");
  servers.push(s);
  await new Promise((r) => s.once("listening", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const hit = (base: string, path = "/api/v1/metrics/realtime", headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers });

describe("keyless requests are rate-limited per IP", () => {
  it("over the limit: 429, saying how to get more, with standard headers", async () => {
    const base = await app({ enabled: true, perMinute: 3 });
    const ip = { "X-Forwarded-For": "203.0.113.10" };
    for (let i = 0; i < 3; i++) expect((await hit(base, undefined, ip)).status).toBe(200);
    const over = await hit(base, undefined, ip);
    expect(over.status).toBe(429);
    expect((await over.json()).error).toMatch(/up to 3 per minute per IP.*API key/);
    expect(over.headers.get("retry-after")).toBeTruthy();
    expect(over.headers.get("ratelimit")).toMatch(/limit=3/);
  });

  it("each IP has its own allowance", async () => {
    const base = await app({ enabled: true, perMinute: 2 });
    const a = { "X-Forwarded-For": "198.51.100.1" };
    const b = { "X-Forwarded-For": "198.51.100.2" };
    await hit(base, undefined, a); await hit(base, undefined, a);
    expect((await hit(base, undefined, a)).status).toBe(429);
    expect((await hit(base, undefined, b)).status).toBe(200); // another caller, unaffected
  });

  it("a request with an API key isn't counted, even from an IP that's over the limit", async () => {
    const base = await app({ enabled: true, perMinute: 1 });
    const ip = { "X-Forwarded-For": "192.0.2.7" };
    await hit(base, undefined, ip);
    expect((await hit(base, undefined, ip)).status).toBe(429);
    for (let i = 0; i < 5; i++) {
      expect((await hit(base, undefined, { ...ip, Authorization: "Bearer vox_live_test" })).status).toBe(200);
    }
  });

  it("the API spec (for the docs page) is never limited", async () => {
    const base = await app({ enabled: true, perMinute: 1 });
    const ip = { "X-Forwarded-For": "192.0.2.8" };
    for (let i = 0; i < 5; i++) expect((await hit(base, "/api/v1/openapi.json", ip)).status).toBe(200);
  });

  it("off (dev, or RATE_LIMIT_DISABLED): nothing is limited", async () => {
    const base = await app({ enabled: false, perMinute: 1 });
    for (let i = 0; i < 5; i++) expect((await hit(base)).status).toBe(200);
  });

  it("the limit is configurable, with a sane default", () => {
    expect(DEFAULT_KEYLESS_PER_MINUTE).toBe(12);
    expect(keylessPerMinute({})).toBe(12);
    expect(keylessPerMinute({ PUBLIC_API_RATE_LIMIT_PER_MINUTE: "120" })).toBe(120);
    for (const bad of ["0", "-5", "abc", "1.5"]) expect(keylessPerMinute({ PUBLIC_API_RATE_LIMIT_PER_MINUTE: bad })).toBe(DEFAULT_KEYLESS_PER_MINUTE);
  });
});
