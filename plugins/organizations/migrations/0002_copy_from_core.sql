-- One-shot data move from Core's public.organizations / public.users /
-- public.org_secrets into this plugin's schema, preserving ids verbatim.
--
-- Runs inside the standard plugin-migration transaction with
-- `SET LOCAL search_path TO "<schema>", public` (server/plugins/migrate.ts),
-- so unqualified names below resolve to the plugin schema and `public.`-
-- qualified names resolve to Core. A RAISE EXCEPTION aborts the transaction,
-- which makes loadPlugins throw and the app refuse to start — the fail-closed
-- contract for this migration (design §6): partial/incorrect data must never
-- become the plugin's source of truth.
--
-- Runs at the connection's default READ COMMITTED isolation (the runner sets
-- none). That is deliberate, not an oversight: each statement below takes a
-- fresh snapshot, so a write committed by an old release still serving
-- during a rolling deploy (between this transaction's copy and its own
-- assertions) is visible to the assertions and trips them — the whole point
-- of checking counts/max(id) here instead of assuming the copy and the
-- check see identical data. REPEATABLE READ would make the copy and the
-- assertions share one snapshot, turning them tautological (always pass)
-- and letting a concurrent write silently go uncopied forever — do not add
-- it. The remaining gap this cannot close — writes the old release makes
-- AFTER this transaction commits — is a deployment-sequencing concern
-- (old container must stop before the new one boots), not something an
-- in-transaction check can catch; see the Task-8 runbook.
--
-- Guards:
--   * Fresh install / Release-B-only activation: public.organizations doesn't
--     exist yet (no Core rows to copy) — NOTICE + return, not an error.
--   * Partial Core schema (public.organizations exists but public.users or
--     public.org_secrets doesn't): named exception rather than a bare
--     "relation does not exist" from deep inside the INSERTs below.
--   * Re-copy: plugin organizations already populated — refuse rather than
--     duplicate or silently no-op.
--   * Preflight: Core permits data shapes the plugin's stricter schema does
--     not (duplicate (organization_id, name) org_secrets rows; a dangling
--     users.organization_id or org_secrets.organization_id with no matching
--     org). Each is checked and named BEFORE any plugin-side row is written,
--     rather than surfacing as a raw constraint/FK violation from inside the
--     INSERTs.
-- Assertions: row counts and max(id) must match on both sides for each of
-- the three tables, plus a value-level check that no copied membership
-- row differs from its Core source, or the whole migration aborts.
DO $$
DECLARE
  preflight_count integer;
  preflight_list  text;
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE NOTICE 'organizations copy: no public.organizations — fresh install, skipping';
    RETURN;
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'organizations copy preflight: public.organizations exists but public.users does not — inconsistent Core schema state, refusing to copy';
  END IF;
  IF to_regclass('public.org_secrets') IS NULL THEN
    RAISE EXCEPTION 'organizations copy preflight: public.organizations exists but public.org_secrets does not — inconsistent Core schema state, refusing to copy';
  END IF;
  IF EXISTS (SELECT 1 FROM organizations) THEN
    RAISE EXCEPTION 'organizations copy: plugin tables already populated — refusing to re-copy';
  END IF;

  -- Preflight 1: Core has no unique constraint on (organization_id, name)
  -- for org_secrets (a plain index only — shared/schema.ts orgSecrets is
  -- index(), not uniqueIndex(); DatabaseStorage.upsertOrgSecret is a
  -- non-atomic read-then-write with no ON CONFLICT), but the plugin's
  -- org_secrets_org_name_uq forbids duplicates. A pre-existing duplicate
  -- would otherwise abort deep inside the INSERT below with a bare
  -- "duplicate key value violates unique constraint" — name it instead.
  SELECT count(*) INTO preflight_count FROM (
    SELECT organization_id, name FROM public.org_secrets
    GROUP BY organization_id, name HAVING count(*) > 1
  ) dup;
  IF preflight_count > 0 THEN
    SELECT string_agg(format('(%s,%s)', organization_id, name), ', ') INTO preflight_list FROM (
      SELECT organization_id, name FROM public.org_secrets
      GROUP BY organization_id, name HAVING count(*) > 1
      ORDER BY organization_id, name
      LIMIT 10
    ) dup;
    RAISE EXCEPTION 'organizations copy preflight: % duplicate (organization_id, name) org_secret rows — deduplicate before enabling the plugin: %',
      preflight_count, preflight_list;
  END IF;

  -- Preflight 2: a users.organization_id with no matching public.organizations
  -- row would otherwise fail deep inside the memberships INSERT with a bare
  -- foreign-key violation — name the offending user ids instead.
  SELECT count(*) INTO preflight_count FROM public.users u
    WHERE u.organization_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = u.organization_id);
  IF preflight_count > 0 THEN
    SELECT string_agg(id::text, ', ') INTO preflight_list FROM (
      SELECT u.id FROM public.users u
      WHERE u.organization_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = u.organization_id)
      ORDER BY u.id
      LIMIT 10
    ) dangling;
    RAISE EXCEPTION 'organizations copy preflight: % users with dangling organization_id (no matching public.organizations row) — fix before enabling the plugin: user ids %',
      preflight_count, preflight_list;
  END IF;

  -- Preflight 3: same class of dangling reference, for org_secrets.
  SELECT count(*) INTO preflight_count FROM public.org_secrets s
    WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = s.organization_id);
  IF preflight_count > 0 THEN
    SELECT string_agg(id::text, ', ') INTO preflight_list FROM (
      SELECT s.id FROM public.org_secrets s
      WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = s.organization_id)
      ORDER BY s.id
      LIMIT 10
    ) dangling;
    RAISE EXCEPTION 'organizations copy preflight: % org_secrets with dangling organization_id (no matching public.organizations row) — fix before enabling the plugin: secret ids %',
      preflight_count, preflight_list;
  END IF;

  INSERT INTO organizations (id, name, address, verified, created_at, updated_at)
    SELECT id, name, address, verified, created_at, updated_at FROM public.organizations;

  -- created_at is copied from the SOURCE USER, not defaulted: the roster
  -- (listMembers → the admin Members page) is ordered by
  -- memberships.created_at DESC, and pre-flip Core ordered the same roster by
  -- users.created_at DESC (its only join-time proxy — Core has no membership
  -- row). Letting DEFAULT now() stand would give every migrated membership the
  -- same instant, leaving ORDER BY with no effective key and reshuffling the
  -- roster of every existing org on cutover day. Both columns are naive
  -- `timestamp` (Core: migrations/0006; plugin: 0001_init.sql), so this is a
  -- same-type copy with no timezone interpretation.
  INSERT INTO memberships (org_ref, user_ref, role, created_at)
    SELECT u.organization_id, u.id, COALESCE(u.org_role::text, 'member'), u.created_at
    FROM public.users u WHERE u.organization_id IS NOT NULL;

  INSERT INTO org_secrets (id, org_ref, name, encrypted_value, broker_type,
                           is_test_account, created_by, created_at, updated_at)
    SELECT id, organization_id, name, encrypted_value, broker_type,
           is_test_account, created_by, created_at, updated_at
    FROM public.org_secrets;

  -- Assertions: counts and max(id) equal on both sides, or the app refuses to start (§6).
  IF (SELECT count(*) FROM organizations) IS DISTINCT FROM (SELECT count(*) FROM public.organizations)
     OR (SELECT coalesce(max(id),0) FROM organizations) IS DISTINCT FROM (SELECT coalesce(max(id),0) FROM public.organizations) THEN
    RAISE EXCEPTION 'organizations copy: organizations parity check failed';
  END IF;
  IF (SELECT count(*) FROM memberships) IS DISTINCT FROM
     (SELECT count(*) FROM public.users WHERE organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'organizations copy: memberships parity check failed';
  END IF;
  -- Value-level check: the count check above can't see a user who MOVED
  -- between orgs or had their role changed between the INSERT and here
  -- (count stays identical, org_ref/role goes stale) — catch that drift too.
  IF EXISTS (
    SELECT id, organization_id, coalesce(org_role::text, 'member') FROM public.users
    WHERE organization_id IS NOT NULL
    EXCEPT
    SELECT user_ref, org_ref, role FROM memberships
  ) THEN
    RAISE EXCEPTION 'organizations copy: memberships parity check failed (value drift)';
  END IF;
  IF (SELECT count(*) FROM org_secrets) IS DISTINCT FROM (SELECT count(*) FROM public.org_secrets)
     OR (SELECT coalesce(max(id),0) FROM org_secrets) IS DISTINCT FROM (SELECT coalesce(max(id),0) FROM public.org_secrets) THEN
    RAISE EXCEPTION 'organizations copy: org_secrets parity check failed';
  END IF;

  PERFORM setval(pg_get_serial_sequence('organizations','id'),
                 (SELECT coalesce(max(id),0)+1 FROM organizations), false);
  PERFORM setval(pg_get_serial_sequence('org_secrets','id'),
                 (SELECT coalesce(max(id),0)+1 FROM org_secrets), false);
END $$;
