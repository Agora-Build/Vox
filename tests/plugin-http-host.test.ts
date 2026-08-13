import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { HttpHost } from "../server/plugins/hosts/http";

describe("HttpHost", () => {
  it("mounts plugin routes under /api/plugins/<id>", async () => {
    const host = new HttpHost();
    const r = host.createRegistrar("sample");
    r.get("/ping", (_req, res) => { res.json({ ok: true }); });
    const app = express();
    host.mount(app);
    const res = await request(app).get("/api/plugins/sample/ping");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("throws on a route conflict", () => {
    const host = new HttpHost();
    const r = host.createRegistrar("sample");
    r.get("/dup", (_req, res) => res.end());
    expect(() => r.get("/dup", (_req, res) => res.end())).toThrow(/route conflict/);
  });

  it("exposes Core auth middleware on the registrar", () => {
    const host = new HttpHost();
    const r = host.createRegistrar("sample");
    expect(typeof r.requireAuth).toBe("function");
    expect(typeof r.requireAdmin).toBe("function");
  });
});
