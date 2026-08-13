import { describe, it, expect } from "vitest";
import samplePlugin from "../server/index";

describe("sample plugin", () => {
  it("registers a route, worker, health check, and the vox.sample service on activate", async () => {
    const registered = { routes: 0, workers: 0, health: 0, services: [] as string[] };
    const fakeCtx: any = {
      pluginId: "sample",
      db: { query: async () => ({ rows: [{ n: "0" }] }) },
      http: (reg: any) => reg({
        get: () => registered.routes++,
        post: () => registered.routes++,
        requireAuth: () => {},
        requireAdmin: () => {},
      }),
      worker: () => registered.workers++,
      health: () => registered.health++,
      provideService: (name: string) => registered.services.push(name),
    };
    await samplePlugin.activate(fakeCtx);
    expect(registered.routes).toBe(2);
    expect(registered.workers).toBe(1);
    expect(registered.health).toBe(1);
    expect(registered.services).toEqual(["vox.sample"]);
  });
});
