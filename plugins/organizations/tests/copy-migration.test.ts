// Tests for plugins/organizations/migrations/0002_copy_from_core.sql — the
// one-shot Core -> plugin data move.
//
// ISOLATION: this file creates FAKE public.organizations / public.users /
// public.org_secrets tables. `public` is shared across vitest workers within
// one database, so if this ran against the shared vox_plugin_test database
// (tests/helpers/plugin-test-db.ts), a concurrently-running provider-contract
// worker replaying 0002 could see these fakes and copy them. So this file
// uses its OWN dedicated, throwaway database — vox_plugin_copy_test — never
// the shared vox_plugin_test DB and never the dev `vox` database.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { readdirSync, readFileSync } from "fs";
import { TEST_PLUGIN_DATABASE_URL } from "../../../tests/helpers/plugin-test-db";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// =====================================================================
// Local, dedicated-DB helper — copied from tests/helpers/plugin-test-db.ts's
// CREATE-DATABASE/42P04 idempotency pattern, but pointed at its own database
// name. Deliberately NOT sharing/modifying that helper: its whole point is a
// SINGLE shared destructive-test database, and this file needs a DIFFERENT,
// private one for the fake-public-tables reason above. Host/credentials are
// still DERIVED from TEST_PLUGIN_DATABASE_URL (which itself honors
// TEST_PLUGIN_DATABASE_URL env overrides) rather than hardcoded, so a
// non-default local Postgres setup only needs to be configured once.
// =====================================================================
const COPY_TEST_DB_NAME = "vox_plugin_copy_test";

function withDatabaseName(name: string): string {
  const url = new URL(TEST_PLUGIN_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

const COPY_TEST_DATABASE_URL = withDatabaseName(COPY_TEST_DB_NAME);

async function ensureCopyTestDatabase(): Promise<void> {
  // CREATE DATABASE can't run against the DB it would create.
  const admin = new Pool({ connectionString: withDatabaseName("postgres") });
  try {
    // CREATE DATABASE can't run inside a transaction block — bare statement.
    await admin.query(`CREATE DATABASE "${COPY_TEST_DB_NAME}"`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "42P04") {
      // 42P04 = duplicate_database (already exists) — anything else is real.
      throw new Error(
        `[copy-migration.test] Could not create the dedicated database "${COPY_TEST_DB_NAME}". ` +
          `Original error: ${(err as Error).message}`,
      );
    }
  } finally {
    await admin.end();
  }
}

// =====================================================================
// Migration replay — same approach as tests/helpers/organizations-db.ts:
// apply the plugin's raw migration SQL directly into a given schema via
// SET LOCAL search_path, bypassing runPluginMigrations' fixed schema name
// and _plugin_schema_versions bookkeeping (neither fits an ad hoc schema).
// =====================================================================
const MIGRATIONS_DIR = "plugins/organizations/migrations";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

async function replay(pool: Pool, schema: string, files: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    for (const file of files) {
      const contents = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf-8");
      const statements = contents.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
      for (const statement of statements) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const ALL_SCHEMAS = [
  "copy_fresh",
  "copy_seeded",
  "copy_tamper",
  "copy_dup_secret",
  "copy_dangling_user",
];

async function resetPublicFixture(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM public.org_secrets`);
  await pool.query(`DELETE FROM public.users`);
  await pool.query(`DELETE FROM public.organizations`);
}

d("0002 copy-from-Core migration (dedicated isolated DB)", () => {
  let pool: Pool | undefined;

  beforeAll(async () => {
    await ensureCopyTestDatabase();
    pool = new Pool({ connectionString: COPY_TEST_DATABASE_URL });
    // Defensive: if a previous run of this file crashed before its afterAll
    // ran, the fake public tables / schemas could still be sitting in the
    // (persistent, reused-across-runs) dedicated database. Case (a) below
    // requires public.organizations to be genuinely absent, so start clean.
    // Tables are dropped before the enum type they depend on.
    await pool.query(`DROP TABLE IF EXISTS public.org_secrets`);
    await pool.query(`DROP TABLE IF EXISTS public.users`);
    await pool.query(`DROP TABLE IF EXISTS public.organizations`);
    await pool.query(`DROP TYPE IF EXISTS public.org_role`);
    for (const schema of ALL_SCHEMAS) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  afterAll(async () => {
    // If beforeAll threw before `pool` was assigned, there is nothing to
    // tear down — reaching into `pool.query` here would throw a fresh
    // TypeError that masks the real (beforeAll) failure.
    if (!pool) return;
    for (const schema of ALL_SCHEMAS) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    }
    await pool.query(`DROP TABLE IF EXISTS public.org_secrets`).catch(() => {});
    await pool.query(`DROP TABLE IF EXISTS public.users`).catch(() => {});
    await pool.query(`DROP TABLE IF EXISTS public.organizations`).catch(() => {});
    await pool.query(`DROP TYPE IF EXISTS public.org_role`).catch(() => {});
    await pool.end();
  });

  it("(a) fresh install: no public.organizations table — 0001+0002 replay succeeds, plugin tables stay empty", async () => {
    // Guard the precondition this case exists to prove: no fake Core table
    // has been created yet in this run.
    const exists = await pool!.query(`SELECT to_regclass('public.organizations') AS r`);
    expect(exists.rows[0].r).toBeNull();

    const schema = "copy_fresh";
    await pool!.query(`CREATE SCHEMA "${schema}"`);
    await replay(pool!, schema, migrationFiles());

    const orgs = await pool!.query(`SELECT count(*)::int AS c FROM "${schema}".organizations`);
    const mems = await pool!.query(`SELECT count(*)::int AS c FROM "${schema}".memberships`);
    const secrets = await pool!.query(`SELECT count(*)::int AS c FROM "${schema}".org_secrets`);
    expect(orgs.rows[0].c).toBe(0);
    expect(mems.rows[0].c).toBe(0);
    expect(secrets.rows[0].c).toBe(0);
  });

  it("(b) seeded Core tables copy verbatim into a fresh schema — ids, roles, ciphertext, timestamp, sequence", async () => {
    // Minimal fake Core tables — only the columns 0002 actually SELECTs, but
    // with REAL Core types where 0002 does type work:
    //  - date columns are naive `timestamp`, matching Core's actual column
    //    type (migrations/0006_org_roles_resources.sql, live DB
    //    information_schema) — the plugin's 0001_init.sql now matches this
    //    exactly, so the copy is same-type, not an implicit
    //    timestamp -> timestamptz cast whose result would depend on the
    //    session's TimeZone GUC (I1). A fake `timestamptz` column here would
    //    make the cast under test an identity cast and never exercise the
    //    real conversion at all.
    //  - org_role is the REAL enum type (not a plain text stand-in), so
    //    0002's `u.org_role::text` cast is exercised for real, and the
    //    enum's labels are pinned against 0001_init.sql's role CHECK.
    await pool!.query(`CREATE TYPE public.org_role AS ENUM ('owner', 'admin', 'member')`);
    await pool!.query(`
      CREATE TABLE public.organizations (
        id integer PRIMARY KEY,
        name text NOT NULL,
        address text,
        verified boolean NOT NULL DEFAULT false,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`);
    await pool!.query(`
      CREATE TABLE public.users (
        id integer PRIMARY KEY,
        organization_id integer,
        org_role public.org_role,
        -- Naive timestamp + NOT NULL DEFAULT now(), matching Core's real column
        -- (shared/schema.ts users.createdAt, live information_schema). 0002
        -- copies it into memberships.created_at, which is NOT NULL — so the
        -- fake must not be nullable either, or this fixture would be laxer than
        -- production.
        created_at timestamp NOT NULL DEFAULT now()
      )`);
    await pool!.query(`
      CREATE TABLE public.org_secrets (
        id integer PRIMARY KEY,
        organization_id integer NOT NULL,
        name text NOT NULL,
        encrypted_value text NOT NULL,
        broker_type text,
        is_test_account boolean NOT NULL DEFAULT false,
        created_by integer,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`);

    // 2 orgs, gappy ids (1, 7). Org 1 gets a fixed naive-timestamp literal
    // to round-trip-check below; org 7 uses the column default.
    await pool!.query(`
      INSERT INTO public.organizations (id, name, address, verified, created_at, updated_at) VALUES
        (1, 'Org One', NULL, true, '2020-06-15 12:34:56', '2020-06-15 12:34:56'),
        (7, 'Org Seven', '123 Elsewhere', false, DEFAULT, DEFAULT)`);

    // 3 members — one with a NULL org_role, which must copy as 'member' —
    // plus a 4th user with organization_id NULL, which must be excluded.
    //
    // created_at values are DISTINCT and deliberately out of user-id order
    // (203 is the newest member of org 1, 201 the oldest): that is the roster
    // ORDER KEY. Pre-flip Core ordered the Members page by users.created_at
    // DESC; the plugin orders by memberships.created_at DESC, so the copy must
    // carry the user's value across or every migrated org's roster reshuffles
    // (all rows would share one DEFAULT now() instant — no effective key).
    await pool!.query(`
      INSERT INTO public.users (id, organization_id, org_role, created_at) VALUES
        (201, 1, 'owner',  '2021-01-01 00:00:00'),
        (202, 7, NULL,     '2021-02-02 11:22:33'),
        (203, 1, 'admin',  '2021-03-03 09:09:09'),
        (204, NULL, NULL,  '2021-04-04 04:04:04')`);

    // 2 secrets, gappy ids (1, 7) tied to the two orgs. One ciphertext
    // fixture is base64-padding/symbol-heavy to catch any re-encoding
    // surprise on the byte-verbatim round trip.
    await pool!.query(`
      INSERT INTO public.org_secrets (id, organization_id, name, encrypted_value) VALUES
        (1, 1, 'API_KEY', 'v1:aa:bb:cc'),
        (7, 7, 'API_KEY', 'v1:$2b$10+/==:unicode-safe-but-symbol-heavy==')`);

    const schema = "copy_seeded";
    await pool!.query(`CREATE SCHEMA "${schema}"`);
    await replay(pool!, schema, migrationFiles());

    const orgs = await pool!.query(`SELECT id, name, verified, created_at FROM "${schema}".organizations ORDER BY id`);
    expect(orgs.rows.map((r) => r.id)).toEqual([1, 7]); // ids verbatim

    // I1: naive-timestamp round trip is byte-identical — no TimeZone-dependent
    // shift from an implicit timestamp -> timestamptz cast (there is none:
    // both sides are now plain `timestamp`).
    //
    // Compared as ::text, not via JS Date: node-pg parses a naive `timestamp`
    // column into a JS Date by treating the wall-clock value as LOCAL time
    // (not UTC), so `.toISOString()` on the returned Date shifts by the
    // process's TZ — a Date-based comparison against a 'Z'-suffixed literal
    // only happens to pass on a UTC machine/CI runner and silently hides the
    // exact class of bug I1 exists to catch on any other TZ. Casting to
    // ::text in SQL reads the stored wall-clock value verbatim, with no
    // timezone interpretation on either the Postgres or the Node side.
    const org1Text = await pool!.query(
      `SELECT created_at::text AS created_at FROM "${schema}".organizations WHERE id = 1`,
    );
    expect(org1Text.rows[0].created_at).toBe("2020-06-15 12:34:56");

    const mems = await pool!.query(`SELECT user_ref, role FROM "${schema}".memberships ORDER BY user_ref`);
    expect(mems.rows).toEqual([
      { user_ref: 201, role: "owner" },
      { user_ref: 202, role: "member" }, // NULL org_role -> 'member'
      { user_ref: 203, role: "admin" },
    ]);

    // I2: the membership's created_at is the SOURCE USER's, not DEFAULT now() —
    // read as ::text for the same TZ-free reason as the org timestamp above.
    const memTimes = await pool!.query(
      `SELECT user_ref, created_at::text AS created_at FROM "${schema}".memberships ORDER BY user_ref`,
    );
    expect(memTimes.rows).toEqual([
      { user_ref: 201, created_at: "2021-01-01 00:00:00" },
      { user_ref: 202, created_at: "2021-02-02 11:22:33" },
      { user_ref: 203, created_at: "2021-03-03 09:09:09" },
    ]);

    // …and therefore the roster order the provider serves (listMembers:
    // ORDER BY created_at DESC) matches the pre-flip users.created_at DESC
    // order: newest member first. With a defaulted created_at every row would
    // tie and this order would be arbitrary.
    const roster = await pool!.query(
      `SELECT user_ref FROM "${schema}".memberships WHERE org_ref = 1 ORDER BY created_at DESC`,
    );
    expect(roster.rows.map((r) => r.user_ref)).toEqual([203, 201]);

    const secrets = await pool!.query(`SELECT id, encrypted_value FROM "${schema}".org_secrets ORDER BY id`);
    expect(secrets.rows).toEqual([
      { id: 1, encrypted_value: "v1:aa:bb:cc" },
      { id: 7, encrypted_value: "v1:$2b$10+/==:unicode-safe-but-symbol-heavy==" }, // byte-identical
    ]);

    // nextval() CONSUMES the sequence value — do this last.
    const seq = await pool!.query(
      `SELECT nextval(pg_get_serial_sequence('${schema}.organizations', 'id')) AS n`,
    );
    expect(Number(seq.rows[0].n)).toBe(8); // max id (7) + 1
    const secretsSeq = await pool!.query(
      `SELECT nextval(pg_get_serial_sequence('${schema}.org_secrets', 'id')) AS n`,
    );
    expect(Number(secretsSeq.rows[0].n)).toBe(8); // same gap pattern, max id (7) + 1
  });

  it("(c) re-running 0002 against the already-populated schema raises 'refusing to re-copy'", async () => {
    // Reuses the "copy_seeded" schema populated by case (b) above — still
    // populated (the sequence nextval() call in (b) doesn't affect this).
    await expect(replay(pool!, "copy_seeded", ["0002_copy_from_core.sql"])).rejects.toThrow(
      /refusing to re-copy/,
    );
  });

  it("(d) tamper: an FK-orphaned plugin-side membership survives a forced-empty organizations table, and the re-run's parity check catches it", async () => {
    // Guard-2 ("already populated") requires `organizations` to be
    // COMPLETELY empty before 0002 will proceed past it. The FK on
    // memberships.org_ref / org_secrets.org_ref (0001, no ON DELETE CASCADE)
    // means a referenced org can never be deleted with `DELETE FROM
    // organizations` while a dependent row still points at it — so a
    // literal "just delete one org row, then re-run the whole file" tamper
    // is blocked outright by referential integrity, and can never reach the
    // parity assertion at all (a partial-but-nonempty `organizations` always
    // re-trips guard-2's "refusing to re-copy" first).
    //
    // To still exercise the parity-assertion code path — which exists as a
    // defensive backstop for exactly this shape of corruption — this test
    // forces the FK aside for one row, producing the state the assertion is
    // designed to catch: `organizations` empty (so guard-2 lets the re-run
    // proceed) while a dependent membership row survives orphaned. That's
    // the deviation from the brief's literal "delete one org row" wording;
    // it's necessitated by the FK RESTRICT semantics in 0001, not a defect
    // in 0002.
    await resetPublicFixture(pool!);
    await pool!.query(`INSERT INTO public.organizations (id, name) VALUES (50, 'Tamper Org')`);
    await pool!.query(`INSERT INTO public.users (id, organization_id, org_role) VALUES (501, 50, 'member')`);

    const schema = "copy_tamper";
    await pool!.query(`CREATE SCHEMA "${schema}"`);
    await replay(pool!, schema, migrationFiles()); // 0001 + 0002, succeeds cleanly

    const before = await pool!.query(`SELECT count(*)::int AS c FROM "${schema}".memberships`);
    expect(before.rows[0].c).toBe(1); // sanity: the membership really did copy

    const fk = await pool!.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"${schema}".memberships'::regclass AND contype = 'f'`,
    );
    expect(fk.rows.length).toBe(1);
    await pool!.query(`ALTER TABLE "${schema}".memberships DROP CONSTRAINT "${fk.rows[0].conname}"`);
    await pool!.query(`DELETE FROM "${schema}".organizations WHERE id = 50`);

    const orgsAfter = await pool!.query(`SELECT count(*)::int AS c FROM "${schema}".organizations`);
    expect(orgsAfter.rows[0].c).toBe(0); // guard-2 bypass condition confirmed
    const memsAfter = await pool!.query(`SELECT count(*)::int AS c FROM "${schema}".memberships`);
    expect(memsAfter.rows[0].c).toBe(1); // the orphaned dependent survives the delete

    // Swap public.users to a DIFFERENT user id (still org 50) before the
    // re-run: memberships.user_ref is UNIQUE, so re-inserting the SAME
    // user_ref (501) as the surviving orphan would trip that unique
    // constraint before the parity assertion is ever reached. A different
    // user_ref isolates the assertion this case is actually testing.
    await pool!.query(`DELETE FROM public.users WHERE id = 501`);
    await pool!.query(`INSERT INTO public.users (id, organization_id, org_role) VALUES (502, 50, 'member')`);

    await expect(replay(pool!, schema, ["0002_copy_from_core.sql"])).rejects.toThrow(
      /memberships parity check failed/,
    );

    // M4: fail-closed has two halves — "raises" and "no partial data
    // survives". The re-run's own INSERTs ran inside its own transaction
    // (via `replay`'s BEGIN/ROLLBACK), so a mid-file failure must leave the
    // schema exactly as it was before this re-run attempt: still no org row,
    // still exactly the one pre-existing orphaned membership — not 2.
    const orgsAfterFail = await pool!.query(`SELECT count(*)::int AS c FROM "${schema}".organizations`);
    const memsAfterFail = await pool!.query(`SELECT count(*)::int AS c FROM "${schema}".memberships`);
    expect(orgsAfterFail.rows[0].c).toBe(0);
    expect(memsAfterFail.rows[0].c).toBe(1);
  });

  it("(e) preflight: duplicate (organization_id, name) org_secrets rows abort before any plugin-side write", async () => {
    // Core has no unique constraint on (organization_id, name) for
    // org_secrets (plain index only; DatabaseStorage.upsertOrgSecret is a
    // non-atomic read-then-write with no ON CONFLICT) — the plugin's
    // org_secrets_org_name_uq does. Seed a pre-existing Core-side duplicate
    // and confirm 0002 names it up front rather than dying inside the
    // INSERT with a bare unique-violation.
    await resetPublicFixture(pool!);
    await pool!.query(`INSERT INTO public.organizations (id, name) VALUES (60, 'Dup Org')`);
    await pool!.query(`
      INSERT INTO public.org_secrets (id, organization_id, name, encrypted_value) VALUES
        (10, 60, 'API_KEY', 'v1'),
        (11, 60, 'API_KEY', 'v2')`);

    const schema = "copy_dup_secret";
    await pool!.query(`CREATE SCHEMA "${schema}"`);
    await expect(replay(pool!, schema, migrationFiles())).rejects.toThrow(
      /duplicate \(organization_id, name\)/,
    );

    // Named preflight fired before any INSERT — and since 0001+0002 replay
    // inside ONE transaction here, the failure rolls back 0001's CREATE
    // TABLE too: the schema ends up with no plugin tables at all, not
    // empty ones. to_regclass proves that (a bare row-count query against a
    // table that no longer exists would itself throw).
    const orgs = await pool!.query(`SELECT to_regclass('"${schema}".organizations') AS r`);
    const secrets = await pool!.query(`SELECT to_regclass('"${schema}".org_secrets') AS r`);
    expect(orgs.rows[0].r).toBeNull();
    expect(secrets.rows[0].r).toBeNull();
  });

  it("(f) preflight: a dangling users.organization_id aborts before any plugin-side write", async () => {
    // The FK that used to prevent this (users.organization_id ->
    // organizations.id) is dropped pre-start by Core migration 0037, before
    // this plugin copy ever runs — so a dangling reference is no longer
    // structurally impossible by the time 0002 executes. Confirm 0002 names
    // the offending user ids up front rather than dying inside the
    // memberships INSERT with a bare foreign-key violation.
    await resetPublicFixture(pool!);
    await pool!.query(`INSERT INTO public.users (id, organization_id, org_role) VALUES (999, 12345, 'member')`);

    const schema = "copy_dangling_user";
    await pool!.query(`CREATE SCHEMA "${schema}"`);
    await expect(replay(pool!, schema, migrationFiles())).rejects.toThrow(
      /dangling organization_id/,
    );

    // Same reasoning as case (e): the whole 0001+0002 transaction rolled
    // back, so the plugin tables don't exist in this schema at all.
    const orgs = await pool!.query(`SELECT to_regclass('"${schema}".organizations') AS r`);
    const mems = await pool!.query(`SELECT to_regclass('"${schema}".memberships') AS r`);
    expect(orgs.rows[0].r).toBeNull();
    expect(mems.rows[0].r).toBeNull();
  });
});
