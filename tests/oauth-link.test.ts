import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "fs";
import type { IdentityService, IdentityUser, PluginDb } from "@vox/plugin-sdk";
import { createPluginDb } from "../server/plugins/db";
import { findOrLinkOrCreate, LoginRefused } from "../plugins/oauth/server/link";
import { TEST_PLUGIN_DATABASE_URL, ensurePluginTestDatabase } from "./helpers/plugin-test-db";

// The oauth plugin's account-linking rules, against its real identities table.
// Core's side (vox.identity) is an in-memory stand-in so each rule is isolated.

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// Worker-scoped schema: test files run in parallel against one shared database.
const schema = `plugin_oauth_${process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? process.pid}`;

function fakeIdentity() {
  const users = new Map<number, IdentityUser>();
  let nextId = 100;
  const created: IdentityUser[] = [];
  const service: IdentityService = {
    async getUserById(id) { return users.get(id) ?? null; },
    async getUserByEmail(email) { return [...users.values()].find((u) => u.email === email) ?? null; },
    async createUser({ email, preferredUsername }) {
      const u: IdentityUser = {
        id: nextId++, username: preferredUsername ?? email, email,
        isAdmin: false, isEnabled: true, emailVerified: true,
      };
      users.set(u.id, u);
      created.push(u);
      return u;
    },
    async markEmailVerified(id) { const u = users.get(id); if (u) u.emailVerified = true; },
    async signIn() {},
    signOut() {},
  };
  const addUser = (u: Partial<IdentityUser> & { id: number; email: string }) => {
    const full: IdentityUser = { username: u.email, isAdmin: false, isEnabled: true, emailVerified: false, ...u };
    users.set(full.id, full);
    return full;
  };
  return { service, users, created, addUser };
}

d("oauth plugin — account linking rules", () => {
  let pool: Pool;
  let db: PluginDb;

  beforeAll(async () => {
    await ensurePluginTestDatabase();
    pool = new Pool({ connectionString: TEST_PLUGIN_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(readFileSync("plugins/oauth/migrations/0001_init.sql", "utf-8"));
    } finally {
      client.release();
    }
    db = createPluginDb(pool, schema);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${schema}".identities`);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  const links = async () =>
    (await pool.query(`SELECT provider, subject, user_id FROM "${schema}".identities ORDER BY provider, subject`)).rows;

  it("a new account creates a user and links it", async () => {
    const id = fakeIdentity();
    const user = await findOrLinkOrCreate(db, id.service, {
      provider: "github", subject: "gh-1", email: "new@example.com", preferredUsername: "newbie",
    });
    expect(id.created).toHaveLength(1);
    expect(user.username).toBe("newbie");
    expect(await links()).toEqual([{ provider: "github", subject: "gh-1", user_id: user.id }]);
  });

  it("signing in again with the same account returns the same user, creating nothing", async () => {
    const id = fakeIdentity();
    const first = await findOrLinkOrCreate(db, id.service, { provider: "github", subject: "gh-2", email: "a@example.com" });
    const again = await findOrLinkOrCreate(db, id.service, { provider: "github", subject: "gh-2", email: "a@example.com" });
    expect(again.id).toBe(first.id);
    expect(id.created).toHaveLength(1);
  });

  it("an existing user with the same email is linked, not duplicated", async () => {
    const id = fakeIdentity();
    const existing = id.addUser({ id: 7, email: "known@example.com", emailVerified: false });
    const user = await findOrLinkOrCreate(db, id.service, { provider: "google", subject: "g-7", email: "known@example.com" });
    expect(user.id).toBe(existing.id);
    expect(id.created).toHaveLength(0);
    expect(existing.emailVerified).toBe(true);
    expect(await links()).toEqual([{ provider: "google", subject: "g-7", user_id: 7 }]);
  });

  it("refuses to link an email whose user is already linked to a DIFFERENT account on that provider", async () => {
    const id = fakeIdentity();
    id.addUser({ id: 8, email: "owner@example.com" });
    await findOrLinkOrCreate(db, id.service, { provider: "github", subject: "gh-owner", email: "owner@example.com" });
    // Someone else's GitHub account claiming the same email must not take the account over.
    await expect(
      findOrLinkOrCreate(db, id.service, { provider: "github", subject: "gh-attacker", email: "owner@example.com" }),
    ).rejects.toThrow(LoginRefused);
    expect(await links()).toEqual([{ provider: "github", subject: "gh-owner", user_id: 8 }]);
  });

  it("the same user may link one GitHub and one Google account", async () => {
    const id = fakeIdentity();
    id.addUser({ id: 9, email: "both@example.com" });
    await findOrLinkOrCreate(db, id.service, { provider: "github", subject: "gh-9", email: "both@example.com" });
    const viaGoogle = await findOrLinkOrCreate(db, id.service, { provider: "google", subject: "g-9", email: "both@example.com" });
    expect(viaGoogle.id).toBe(9);
    expect((await links()).map((l) => l.provider)).toEqual(["github", "google"]);
  });

  it("refuses a disabled account, whether matched by link or by email", async () => {
    const id = fakeIdentity();
    const u = id.addUser({ id: 10, email: "off@example.com", isEnabled: false });
    await expect(
      findOrLinkOrCreate(db, id.service, { provider: "github", subject: "gh-10", email: "off@example.com" }),
    ).rejects.toThrow(/disabled/);
    expect(await links()).toEqual([]);

    await pool.query(`INSERT INTO "${schema}".identities (provider, subject, user_id) VALUES ('github', 'gh-10', $1)`, [u.id]);
    await expect(
      findOrLinkOrCreate(db, id.service, { provider: "github", subject: "gh-10", email: "off@example.com" }),
    ).rejects.toThrow(/disabled/);
  });

  it("a link to a user that no longer exists is dropped and the sign-in re-resolved", async () => {
    const id = fakeIdentity();
    await pool.query(`INSERT INTO "${schema}".identities (provider, subject, user_id) VALUES ('google', 'g-ghost', 999)`);
    const user = await findOrLinkOrCreate(db, id.service, { provider: "google", subject: "g-ghost", email: "ghost@example.com" });
    expect(user.id).not.toBe(999);
    expect(await links()).toEqual([{ provider: "google", subject: "g-ghost", user_id: user.id }]);
  });
});
