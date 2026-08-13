import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { HealthHost } from "../server/plugins/hosts/health";

describe("HealthHost", () => {
  it("lists plugins and reports health", async () => {
    const host = new HealthHost();
    host.setMeta("sample", { version: "1.0.0", provides: ["vox.sample"], requires: [] });
    host.register("sample", async () => ({ status: "ok" }));
    const app = express();
    host.routes(app);

    const list = await request(app).get("/api/plugins");
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      { id: "sample", version: "1.0.0", servicesProvided: ["vox.sample"], servicesRequired: [] },
    ]);

    const health = await request(app).get("/api/plugins/sample/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok" });
  });

  it("404s an unknown plugin health check", async () => {
    const host = new HealthHost();
    const app = express();
    host.routes(app);
    const res = await request(app).get("/api/plugins/nope/health");
    expect(res.status).toBe(404);
  });
});
