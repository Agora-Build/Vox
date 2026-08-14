import { describe, it, expect, vi } from "vitest";
import { registerCreditsRoutes } from "../server/routes";
import type { CreditsService } from "../server/service";
import type { RouteRegistrar } from "@vox/plugin-sdk";

function fakeService(over: Partial<CreditsService> = {}): CreditsService {
  return {
    getBalance: vi.fn(async () => 0),
    deposit: vi.fn(async () => ({ groupId: "g" })),
    hold: vi.fn(async () => ({ holdId: 1 })),
    capture: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    getStatement: vi.fn(async () => ({ entries: [], nextCursor: null })),
    ...over,
  };
}

interface Captured { method: string; path: string; handler: (req: any, res: any) => any; }

function capture(): { r: RouteRegistrar; routes: Captured[] } {
  const routes: Captured[] = [];
  const authMark = () => {};
  const add = (method: string) => (path: string, ...handlers: any[]) =>
    routes.push({ method, path, handler: handlers[handlers.length - 1] });
  const r = {
    get: add("get"), post: add("post"), patch: add("patch"), delete: add("delete"),
    requireAuth: authMark, requireAdmin: authMark,
  } as unknown as RouteRegistrar;
  return { r, routes };
}

function res() {
  const o: any = { code: 200, body: undefined };
  o.status = (c: number) => { o.code = c; return o; };
  o.json = (b: unknown) => { o.body = b; return o; };
  return o;
}

describe("credits routes", () => {
  it("registers exactly the four documented routes", () => {
    const { r, routes } = capture();
    registerCreditsRoutes(r, fakeService());
    expect(routes.map((x) => `${x.method.toUpperCase()} ${x.path}`).sort()).toEqual([
      "GET /accounts", "GET /balance", "GET /statement", "POST /grants",
    ]);
  });

  it("balance returns the caller's own balance from the session", async () => {
    const svc = fakeService({ getBalance: vi.fn(async (uid: number) => (uid === 42 ? 500 : 0)) });
    const { r, routes } = capture();
    registerCreditsRoutes(r, svc);
    const balance = routes.find((x) => x.path === "/balance")!;
    const out = res();
    await balance.handler({ session: { userId: 42 }, query: {} }, out);
    expect(out.body).toEqual({ credits: 500, asOf: expect.any(String) });
    expect(svc.getBalance).toHaveBeenCalledWith(42);
  });

  it("grants forwards the admin body to deposit", async () => {
    const svc = fakeService();
    const { r, routes } = capture();
    registerCreditsRoutes(r, svc);
    const grants = routes.find((x) => x.path === "/grants")!;
    const out = res();
    await grants.handler(
      { session: { userId: 1 }, body: { userId: 9, credits: 100, reason: "grant", idempotencyKey: "k1" } }, out);
    expect(svc.deposit).toHaveBeenCalledWith({ userId: 9, credits: 100, reason: "grant", idempotencyKey: "k1" });
    expect(out.code).toBe(201);
  });

  it("grants rejects a malformed body with 400", async () => {
    const svc = fakeService();
    const { r, routes } = capture();
    registerCreditsRoutes(r, svc);
    const grants = routes.find((x) => x.path === "/grants")!;
    const out = res();
    await grants.handler({ session: { userId: 1 }, body: { userId: 9 } }, out);
    expect(out.code).toBe(400);
    expect(svc.deposit).not.toHaveBeenCalled();
  });
});
