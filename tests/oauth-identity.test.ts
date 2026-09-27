import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import { pickVerifiedGithubEmail } from "../plugins/oauth/server/providers";
import { identityService } from "../server/identity";
import { storage, pool } from "../server/storage";

// Review fixes on the oauth path: which GitHub email may be trusted, session
// rotation on sign-in, and case-insensitive email matching.

describe("pickVerifiedGithubEmail — only a verified email may link accounts", () => {
  it("prefers the primary verified address", () => {
    expect(pickVerifiedGithubEmail([
      { email: "other@x.com", primary: false, verified: true },
      { email: "main@x.com", primary: true, verified: true },
    ])).toBe("main@x.com");
  });

  it("never picks an unverified address, even the primary", () => {
    expect(pickVerifiedGithubEmail([
      { email: "victim@x.com", primary: true, verified: false },
      { email: "mine@x.com", primary: false, verified: true },
    ])).toBe("mine@x.com");
    expect(pickVerifiedGithubEmail([{ email: "victim@x.com", primary: true, verified: false }])).toBeNull();
  });
});

describe("identity.signIn — rotates the session", () => {
  it("regenerates the session before recording the user, dropping what was there", async () => {
    let regenerated = 0;
    let saved = 0;
    const makeSession = (data: Record<string, unknown>): Record<string, unknown> => ({
      ...data,
      regenerate(cb: (err?: Error) => void) {
        regenerated++;
        req.session = makeSession({}) as unknown as Request["session"];
        cb();
      },
      save(cb: (err?: Error) => void) {
        saved++;
        cb();
      },
    });
    const req = { session: makeSession({ oauthState: { provider: "github", value: "x" }, planted: "attacker" }) } as unknown as Request;
    const before = req.session;

    await identityService.signIn(req, 42);

    expect(regenerated).toBe(1);
    expect(saved).toBe(1);
    expect(req.session).not.toBe(before);
    expect((req.session as unknown as Record<string, unknown>).userId).toBe(42);
    expect((req.session as unknown as Record<string, unknown>).planted).toBeUndefined();
  });
});

const hasDb = !!process.env.DATABASE_URL;
(hasDb ? describe : describe.skip)("identity.getUserByEmail — case-insensitive", () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const created: number[] = [];

  afterAll(async () => {
    if (created.length) await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [created]);
  });

  it("finds an existing user whatever case the provider reports", async () => {
    const u = await storage.createUser({
      username: `ci_${stamp}`, email: `Mixed.Case_${stamp}@Example.com`, passwordHash: null,
      plan: "basic", isAdmin: false, isEnabled: true,
    } as never);
    created.push(u.id);
    const found = await identityService.getUserByEmail(`mixed.case_${stamp}@example.com`);
    expect(found?.id).toBe(u.id);
  });

  it("prefers the exact match when two accounts differ only by case", async () => {
    const lower = await storage.createUser({
      username: `cl_${stamp}`, email: `dup_${stamp}@example.com`, passwordHash: null,
      plan: "basic", isAdmin: false, isEnabled: true,
    } as never);
    const upper = await storage.createUser({
      username: `cu_${stamp}`, email: `DUP_${stamp}@EXAMPLE.COM`, passwordHash: null,
      plan: "basic", isAdmin: false, isEnabled: true,
    } as never);
    created.push(lower.id, upper.id);
    expect((await identityService.getUserByEmail(`DUP_${stamp}@EXAMPLE.COM`))?.id).toBe(upper.id);
    expect((await identityService.getUserByEmail(`dup_${stamp}@example.com`))?.id).toBe(lower.id);
    // Neither exact: the oldest.
    expect((await identityService.getUserByEmail(`Dup_${stamp}@Example.com`))?.id).toBe(lower.id);
  });
});
