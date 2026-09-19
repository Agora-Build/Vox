// Read-path contract for the organizations plugin provider, PORTED from
// tests/organizations-core.test.ts (CoreOrganizations) so behavior stays
// equivalence-locked against the Core implementation it replaces. Case names
// are kept recognizably parallel to that file; seeding swaps storage-fixture
// objects for direct SQL through the per-worker harness.
//
// THIS FILE IS THAT CORPUS NOW: the Release A flip deleted both
// CoreOrganizations and tests/organizations-core.test.ts, so the citations to
// them here are historical pointers into git history (`git show
// b13c12a:tests/organizations-core.test.ts`). Every case of the old suite lives
// on below, except the null-org_role one noted next — do not drop cases here
// without a replacement.
//
// Deliberately NOT ported: CoreOrganizations' "treats a null org_role as
// 'member'" case. That's a Core-column artifact (users.org_role is nullable);
// the plugin's `memberships.role` is NOT NULL, and the null->'member' mapping
// happens once, at COPY-migration time — not on every read.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupOrganizationsDb, type OrgsHarness } from "../../../tests/helpers/organizations-db";
import type { Organization, OrganizationsProvider as PluginContract } from "../server/types";
import { AlreadyMemberError } from "../server/types";
import { ServiceRegistry } from "../../../server/plugins/registry";
import { makeServicesView } from "../../../server/plugins/loader";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("organizations plugin provider — reads", () => {
  let h: OrgsHarness;
  let orgAcme: Organization;
  let orgEmptyId: number;

  beforeAll(async () => {
    h = await setupOrganizationsDb();

    const acmeRow = await h.db.query<{ id: number }>(
      `INSERT INTO organizations (name, address, verified, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      ["Acme", null, true, new Date("2020-01-01T00:00:00Z")],
    );
    const acmeId = acmeRow.rows[0].id;
    orgAcme = {
      id: acmeId,
      name: "Acme",
      address: null,
      verified: true,
      createdAt: new Date("2020-01-01T00:00:00Z"),
      updatedAt: new Date("2020-01-01T00:00:00Z"),
    };

    // Members seeded with distinct created_at, out of user-id order, so an
    // ordering assertion is meaningful (insertion order != created_at order).
    // user 1 = owner, user 2 = member, user 4 = member, user 3 = never a
    // member (mirrors organizationId: null in the Core fixture), user 999 =
    // unknown.
    await h.db.query(
      `INSERT INTO memberships (org_ref, user_ref, role, created_at) VALUES
       ($1, 2, 'member', '2020-01-01T00:00:00Z'),
       ($1, 1, 'owner',  '2020-01-02T00:00:00Z'),
       ($1, 4, 'member', '2020-01-03T00:00:00Z')`,
      [acmeId],
    );

    const emptyRow = await h.db.query<{ id: number }>(
      `INSERT INTO organizations (name, address, verified) VALUES ('Empty', NULL, false) RETURNING id`,
    );
    orgEmptyId = emptyRow.rows[0].id;
  });

  afterAll(async () => {
    await h.pool.query(`DROP SCHEMA IF EXISTS "${h.schema}" CASCADE`);
    await h.pool.end();
  });

  describe("getMembership", () => {
    it("reads membership and role from the membership row", async () => {
      expect(await h.provider.getMembership(1)).toEqual({ organizationId: orgAcme.id, role: "owner" });
    });

    it("returns null for a user in no org", async () => {
      expect(await h.provider.getMembership(3)).toBeNull();
    });

    it("returns null for an unknown user", async () => {
      expect(await h.provider.getMembership(999)).toBeNull();
    });
  });

  describe("getMemberships", () => {
    it("batches memberships and omits users with no org", async () => {
      const map = await h.provider.getMemberships([1, 3, 4, 999]);
      expect(map.get(1)).toEqual({ organizationId: orgAcme.id, role: "owner" });
      expect(map.get(4)).toEqual({ organizationId: orgAcme.id, role: "member" });
      expect(map.has(3)).toBe(false);
      expect(map.has(999)).toBe(false);
    });

    it("resolves via ONE query, not one per user — ports the N+1 fix", async () => {
      const spy = vi.spyOn(h.db, "query");
      spy.mockClear();
      await h.provider.getMemberships([1, 2, 4, 999]);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("returns an empty Map WITHOUT querying for empty input", async () => {
      const spy = vi.spyOn(h.db, "query");
      spy.mockClear();
      const map = await h.provider.getMemberships([]);
      expect(map.size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("getOrganization", () => {
    it("returns the FULL row (address/verified/timestamps), not a summary", async () => {
      const org = await h.provider.getOrganization(orgAcme.id);
      expect(org).toEqual(orgAcme); // `verified`, not `isVerified`
      expect(org?.createdAt).toBeInstanceOf(Date);
      expect(org?.updatedAt).toBeInstanceOf(Date);
    });

    it("returns null for an unknown org", async () => {
      expect(await h.provider.getOrganization(999999)).toBeNull();
    });
  });

  describe("listMembers", () => {
    it("lists members with their roles, ordered by created_at DESC", async () => {
      expect(await h.provider.listMembers(orgAcme.id)).toEqual([
        { userId: 4, role: "member" },
        { userId: 1, role: "owner" },
        { userId: 2, role: "member" },
      ]);
    });

    it("returns an empty array for an org with no members", async () => {
      expect(await h.provider.listMembers(orgEmptyId)).toEqual([]);
    });
  });

  describe("counts", () => {
    it("countMembers and countOrgAdmins delegate", async () => {
      expect(await h.provider.countMembers(orgAcme.id)).toBe(3);
      expect(await h.provider.countOrgAdmins(orgAcme.id)).toBe(1);
    });

    it("return a NUMBER, not pg's count string — the adapters do arithmetic on it", async () => {
      // `SELECT count(*)` arrives as a STRING (pg int8); the provider's Number()
      // wrapper is what makes the last-admin guard's `countOrgAdmins(...) <= 1`
      // (routes.ts) a numeric comparison instead of a lexical one. The toBe()
      // cases above would catch a dropped wrapper today, but only incidentally
      // (toBe is ===, so "3" fails) — this states the contract directly.
      expect(typeof (await h.provider.countMembers(orgAcme.id))).toBe("number");
      expect(typeof (await h.provider.countOrgAdmins(orgAcme.id))).toBe("number");
    });

    it("are zero for an org with no members", async () => {
      expect(await h.provider.countMembers(orgEmptyId)).toBe(0);
      expect(await h.provider.countOrgAdmins(orgEmptyId)).toBe(0);
    });
  });

  describe("listOrganizations", () => {
    it("returns full rows ordered by created_at DESC", async () => {
      // Inserted here, AFTER orgAcme (2020) and orgEmpty (now), with an
      // OLDER created_at — insertion order therefore disagrees with
      // created_at order, making the assertion below meaningful.
      const oldRow = await h.db.query<{ id: number }>(
        `INSERT INTO organizations (name, address, verified, created_at, updated_at)
         VALUES ('Old Co', NULL, false, '2010-01-01T00:00:00Z', '2010-01-01T00:00:00Z') RETURNING id`,
      );
      const list = await h.provider.listOrganizations();
      const ids = list.map((o) => o.id);
      const idxEmpty = ids.indexOf(orgEmptyId);
      const idxAcme = ids.indexOf(orgAcme.id);
      const idxOld = ids.indexOf(oldRow.rows[0].id);
      expect(idxEmpty).toBeGreaterThanOrEqual(0);
      expect(idxAcme).toBeGreaterThanOrEqual(0);
      expect(idxOld).toBeGreaterThanOrEqual(0);
      // orgEmpty (created "now") is the newest, Old Co (2010) the oldest.
      expect(idxEmpty).toBeLessThan(idxAcme);
      expect(idxAcme).toBeLessThan(idxOld);
    });
  });
});

// Mutations + org secrets, PORTED from tests/organizations-core.test.ts
// (CoreOrganizations "mutation" cases at the bottom of that file), plus the
// plugin-specific cases (atomic create, the
// 23505 race backstop, the org-scoped removeMember tightening). Runs in its
// own harness/schema so this block's writes never leak into the read-only
// fixtures above.
d("organizations plugin provider — mutations", () => {
  let h: OrgsHarness;
  let orgMut: Organization;

  beforeAll(async () => {
    h = await setupOrganizationsDb();
    const row = await h.db.query<{ id: number }>(
      `INSERT INTO organizations (name, address, verified) VALUES ('MutOrg', NULL, false) RETURNING id`,
    );
    orgMut = {
      id: row.rows[0].id,
      name: "MutOrg",
      address: null,
      verified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  afterAll(async () => {
    await h.pool.query(`DROP SCHEMA IF EXISTS "${h.schema}" CASCADE`);
    await h.pool.end();
  });

  describe("createOrganization", () => {
    it("creates the org and makes the creator its owner", async () => {
      const org = await h.provider.createOrganization({ name: "New Co" }, { userId: 501 });
      expect(org.name).toBe("New Co");
      expect(org.address).toBeNull();
      expect(org.verified).toBe(false);
      expect(await h.provider.getMembership(501)).toEqual({ organizationId: org.id, role: "owner" });
    });

    it("commits the org insert and the owner membership atomically, in ONE withTransaction call — an upgrade over Core's sequential writes (organizations-core.ts:88-93)", async () => {
      const spy = vi.spyOn(h.db, "withTransaction");
      spy.mockClear();
      await h.provider.createOrganization({ name: "Atomic Co" }, { userId: 502 });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("refuses a creator who already belongs to an org", async () => {
      // user 501 became an owner in the first test above.
      await expect(h.provider.createOrganization({ name: "X" }, { userId: 501 }))
        .rejects.toBeInstanceOf(AlreadyMemberError);
    });
  });

  describe("addMember", () => {
    it("adds a user to an org with the given role", async () => {
      await h.provider.addMember(orgMut.id, 503, "member");
      expect(await h.provider.getMembership(503)).toEqual({ organizationId: orgMut.id, role: "member" });
    });

    it("enforces at-most-one-org with AlreadyMemberError", async () => {
      // user 501 already owns an org (from the createOrganization tests above).
      await expect(h.provider.addMember(orgMut.id, 501, "member")).rejects.toBeInstanceOf(AlreadyMemberError);
    });

    it("maps a 23505 unique-violation on memberships_user_uq to AlreadyMemberError — a race backstop Core cannot have", async () => {
      // Seed a real membership row directly, simulating a concurrent addMember
      // that landed between this call's precheck and its insert.
      await h.db.query(
        `INSERT INTO memberships (org_ref, user_ref, role) VALUES ($1, 505, 'member')`, [orgMut.id],
      );
      // Defeat just the precheck SELECT (first call) so the INSERT (second
      // call) actually hits the DB and trips the real unique constraint.
      const spy = vi.spyOn(h.db, "query").mockImplementationOnce(async () => ({ rows: [] }));
      try {
        await expect(h.provider.addMember(orgMut.id, 505, "admin")).rejects.toBeInstanceOf(AlreadyMemberError);
      } finally {
        spy.mockRestore();
      }
      // The race backstop must not have mutated the row (insert failed).
      expect((await h.provider.getMembership(505))?.role).toBe("member");
    });

    it("rethrows any OTHER pg error untouched (not swallowed as AlreadyMemberError)", async () => {
      // role is CHECK-constrained to owner/admin/member — 'bogus' trips a
      // check violation (23514), not a unique violation, so it must propagate.
      await expect(h.provider.addMember(orgMut.id, 506, "bogus" as never)).rejects.not.toBeInstanceOf(AlreadyMemberError);
    });
  });

  describe("updateOrganization", () => {
    it("patches name only, leaving address untouched", async () => {
      const row = await h.db.query<{ id: number }>(
        `INSERT INTO organizations (name, address, verified) VALUES ('Patchable', '1 Main St', false) RETURNING id`,
      );
      const id = row.rows[0].id;
      const updated = await h.provider.updateOrganization(id, { name: "Patched" });
      expect(updated.name).toBe("Patched");
      expect(updated.address).toBe("1 Main St");
    });

    it("an empty patch bumps updated_at without touching name/address", async () => {
      const row = await h.db.query<{ id: number }>(
        `INSERT INTO organizations (name, address, verified) VALUES ('Untouched', 'keep-me', false) RETURNING id`,
      );
      const id = row.rows[0].id;
      const before = await h.provider.getOrganization(id);
      await new Promise((r) => setTimeout(r, 5));
      const updated = await h.provider.updateOrganization(id, {});
      expect(updated.name).toBe("Untouched");
      expect(updated.address).toBe("keep-me");
      expect(updated.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
    });

    // Key-presence semantics, pinned as three cases because the difference
    // between them is exactly the M1 divergence the final review found: an
    // EXPLICIT null must clear the column (BASE Core: `.set({ ...patch })`, and
    // drizzle filters only `undefined`), while an absent key must not. The
    // route forwards `address` whenever it is not undefined, so raw JSON
    // `{"address": null}` reaches the provider in production.
    it("an EXPLICIT null address CLEARS it — BASE Core parity (drizzle filtered only undefined)", async () => {
      const row = await h.db.query<{ id: number }>(
        `INSERT INTO organizations (name, address, verified) VALUES ('Clearable', '1 Main St', false) RETURNING id`,
      );
      const id = row.rows[0].id;
      const updated = await h.provider.updateOrganization(id, { address: null } as { address?: string });
      expect(updated.address).toBeNull();
      expect(updated.name).toBe("Clearable"); // name absent from the patch — untouched
      // Re-read, so this is a stored-value assertion, not just a RETURNING one.
      expect((await h.provider.getOrganization(id))?.address).toBeNull();
    });

    it("an address key omitted from the patch leaves the stored address alone", async () => {
      const row = await h.db.query<{ id: number }>(
        `INSERT INTO organizations (name, address, verified) VALUES ('Keeper', '2 Side St', false) RETURNING id`,
      );
      const id = row.rows[0].id;
      const updated = await h.provider.updateOrganization(id, { name: "Keeper 2" });
      expect(updated.address).toBe("2 Side St");
      expect((await h.provider.getOrganization(id))?.address).toBe("2 Side St");
    });

    it("an EXPLICITLY undefined address is treated as absent, not as a clear", async () => {
      const row = await h.db.query<{ id: number }>(
        `INSERT INTO organizations (name, address, verified) VALUES ('Undef', '3 Back Rd', false) RETURNING id`,
      );
      const id = row.rows[0].id;
      const updated = await h.provider.updateOrganization(id, { name: "Undef 2", address: undefined });
      expect(updated.address).toBe("3 Back Rd");
    });

    it("throws Error('organization not found') for an unknown org — EXACT string, adapters string-match it", async () => {
      await expect(h.provider.updateOrganization(999999, { name: "x" })).rejects.toThrow("organization not found");
    });
  });

  describe("setVerified", () => {
    it("writes the verified column", async () => {
      await h.provider.setVerified(orgMut.id, true);
      expect((await h.provider.getOrganization(orgMut.id))?.verified).toBe(true);
      await h.provider.setVerified(orgMut.id, false); // restore for later assertions
    });

    it("is a silent no-op for an unknown org (mirrors Core: setVerified bypasses the checked updateOrganization wrapper)", async () => {
      await expect(h.provider.setVerified(999999, true)).resolves.toBeUndefined();
    });
  });

  describe("setMemberRole / removeMember", () => {
    it("setMemberRole / removeMember round-trip", async () => {
      await h.provider.addMember(orgMut.id, 507, "member");
      await h.provider.setMemberRole(orgMut.id, 507, "admin");
      expect((await h.provider.getMembership(507))?.role).toBe("admin");
      await h.provider.removeMember(orgMut.id, 507);
      expect(await h.provider.getMembership(507)).toBeNull();
    });

    it("setMemberRole on an unknown userId is a silent no-op (Phase-1 T2 carry: 404 guard lives in Core, ahead of this call)", async () => {
      await expect(h.provider.setMemberRole(orgMut.id, 999999, "admin")).resolves.toBeUndefined();
    });

    it("removeMember on an unknown userId is a silent no-op", async () => {
      await expect(h.provider.removeMember(orgMut.id, 999999)).resolves.toBeUndefined();
    });

    it("removeMember does not remove a member of a DIFFERENT org when userId matches but orgId doesn't", async () => {
      await h.provider.addMember(orgMut.id, 508, "member");
      const otherOrg = await h.db.query<{ id: number }>(
        `INSERT INTO organizations (name, address, verified) VALUES ('Other Org', NULL, false) RETURNING id`,
      );
      await h.provider.removeMember(otherOrg.rows[0].id, 508); // wrong org — must no-op
      expect(await h.provider.getMembership(508)).toEqual({ organizationId: orgMut.id, role: "member" });
    });
  });

  describe("org secrets", () => {
    it("upsertOrgSecret INSERT sets created_by from input and passes the ciphertext through untouched", async () => {
      const row = await h.provider.upsertOrgSecret(orgMut.id, {
        name: "API_KEY",
        encryptedValue: "v1:aa:bb:cc",
        brokerType: null,
        isTestAccount: false,
        createdBy: 1,
      });
      expect(row.encryptedValue).toBe("v1:aa:bb:cc"); // untouched — provider never decrypts
      expect(row.brokerType).toBeNull();
      expect(row.isTestAccount).toBe(false);
      expect(row.createdBy).toBe(1);
      expect(row.organizationId).toBe(orgMut.id);
    });

    it("upsertOrgSecret UPDATE (on org_ref+name conflict) overwrites the mutable fields but PRESERVES the ORIGINAL created_by", async () => {
      // "API_KEY" already exists from the previous test, created_by: 1.
      const updated = await h.provider.upsertOrgSecret(orgMut.id, {
        name: "API_KEY",
        encryptedValue: "v2:dd:ee:ff",
        brokerType: "elevenlabs",
        isTestAccount: true,
        createdBy: 999, // a different creator on the input — must NOT overwrite
      });
      expect(updated.encryptedValue).toBe("v2:dd:ee:ff");
      expect(updated.brokerType).toBe("elevenlabs");
      expect(updated.isTestAccount).toBe(true);
      expect(updated.createdBy).toBe(1); // original creator survives rotation
    });

    it("listOrgSecrets is ordered by created_at DESC and round-trips ciphertext byte-verbatim", async () => {
      // Fixture deliberately includes base64 padding/specials to catch any
      // re-encoding surprise.
      const fixture = "v1:$2b$10+/==:unicode-safe-but-symbol-heavy==";
      await h.db.query(
        `INSERT INTO org_secrets (org_ref, name, encrypted_value, created_by, created_at, updated_at)
         VALUES ($1, 'OLDER', $2, 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
        [orgMut.id, fixture],
      );
      const secrets = await h.provider.listOrgSecrets(orgMut.id);
      const names = secrets.map((s) => s.name);
      expect(names.indexOf("API_KEY")).toBeLessThan(names.indexOf("OLDER")); // newer first
      const older = secrets.find((s) => s.name === "OLDER");
      expect(older?.encryptedValue).toBe(fixture); // byte-verbatim round trip
    });

    it("deleteOrgSecret deletes exactly the (org_ref, name) row and no-ops when absent", async () => {
      const otherOrg = await h.db.query<{ id: number }>(
        `INSERT INTO organizations (name, address, verified) VALUES ('Secret Sibling', NULL, false) RETURNING id`,
      );
      await h.provider.upsertOrgSecret(otherOrg.rows[0].id, {
        name: "API_KEY", encryptedValue: "sibling-value", brokerType: null, isTestAccount: false, createdBy: 1,
      });

      await h.provider.deleteOrgSecret(orgMut.id, "API_KEY");
      expect((await h.provider.listOrgSecrets(orgMut.id)).map((s) => s.name)).not.toContain("API_KEY");
      // Same-named secret in a DIFFERENT org must survive.
      expect((await h.provider.listOrgSecrets(otherOrg.rows[0].id)).map((s) => s.name)).toContain("API_KEY");

      await expect(h.provider.deleteOrgSecret(orgMut.id, "does-not-exist")).resolves.toBeUndefined();
    });
  });
});

// Step 3 (design §10 layer 2): register the plugin provider through a real
// ServiceRegistry + makeServicesView, the same resolution path Core routes
// use, and assert a seeded membership resolves identically via optional<>()
// as it does calling the provider directly — porting the INTENT of
// tests/organizations-override.test.ts's FakeOrganizations widening test to
// the real plugin provider.
d("organizations plugin provider — registered via ServiceRegistry", () => {
  let h: OrgsHarness;
  let orgId: number;

  beforeAll(async () => {
    h = await setupOrganizationsDb();
    const row = await h.db.query<{ id: number }>(
      `INSERT INTO organizations (name, address, verified) VALUES ('RegOrg', NULL, true) RETURNING id`,
    );
    orgId = row.rows[0].id;
    await h.db.query(
      `INSERT INTO memberships (org_ref, user_ref, role) VALUES ($1, 701, 'admin')`, [orgId],
    );
  });

  afterAll(async () => {
    await h.pool.query(`DROP SCHEMA IF EXISTS "${h.schema}" CASCADE`);
    await h.pool.end();
  });

  it("optional<>() resolves the SAME provider instance the registry was given", () => {
    const registry = new ServiceRegistry();
    registry.provide("vox.organizations", "1.0.0", h.provider);
    const view = makeServicesView(registry);
    expect(view.optional<PluginContract>("vox.organizations", "^1.0.0")).toBe(h.provider);
  });

  it("a seeded membership resolves identically via optional<>() and via the provider directly", async () => {
    const registry = new ServiceRegistry();
    registry.provide("vox.organizations", "1.0.0", h.provider);
    const view = makeServicesView(registry);
    const resolved = view.optional<PluginContract>("vox.organizations", "^1.0.0");

    const direct = await h.provider.getMembership(701);
    const viaRegistry = await resolved!.getMembership(701);
    expect(viaRegistry).toEqual(direct);
    expect(viaRegistry).toEqual({ organizationId: orgId, role: "admin" });
  });
});
