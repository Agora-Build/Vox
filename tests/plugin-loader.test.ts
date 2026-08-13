import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { VoxPlugin } from "@vox/plugin-sdk";
import { loadPlugins } from "../server/plugins/loader";

// connect() must resolve a client-like object (query + release) — runPluginMigrations
// grabs a dedicated connection for its session-scoped advisory lock even when a
// plugin has no migrations directory to apply. A bare `vi.fn()` (undefined return)
// makes `lockClient.release()` throw in the migration runner's outer `finally`,
// masking the real failure.
const fakeClient = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
const fakePool = { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn().mockResolvedValue(fakeClient) } as any;

describe("loadPlugins", () => {
  it("is a no-op when VOX_PLUGINS is empty", async () => {
    const prev = process.env.VOX_PLUGINS;
    delete process.env.VOX_PLUGINS;
    const app = express();
    const loaded = await loadPlugins(app, fakePool, {});
    await loaded.shutdown();
    process.env.VOX_PLUGINS = prev;
    expect(true).toBe(true);
  });

  it("throws for an unknown plugin id", async () => {
    process.env.VOX_PLUGINS = "ghost";
    const app = express();
    await expect(loadPlugins(app, fakePool, {})).rejects.toThrow(/unknown plugin/);
    delete process.env.VOX_PLUGINS;
  });

  it("activates a fake plugin, mounts its route, and exposes health", async () => {
    process.env.VOX_PLUGINS = "fake";
    const activate = vi.fn(async (ctx: any) => {
      ctx.http((r: any) => r.get("/hi", (_req: any, res: any) => res.json({ hi: true })));
      ctx.health(async () => ({ status: "ok" }));
    });
    const fake: VoxPlugin = { activate };
    const app = express();
    // migrations no-op: manifest has empty migrations dir handling; fake pool returns []
    const loaded = await loadPlugins(app, fakePool, { fake }, "tests/fixtures/plugins");
    const hi = await request(app).get("/api/plugins/fake/hi");
    expect(hi.body).toEqual({ hi: true });
    const health = await request(app).get("/api/plugins/fake/health");
    expect(health.body).toEqual({ status: "ok" });
    await loaded.shutdown();
    delete process.env.VOX_PLUGINS;
  });
});
