-- Release A: drop the 10 org FK constraints on Core tables.
-- org ids become opaque integers on Core; organizations/org_secrets tables remain.
-- org_secrets keeps its FK — it travels with its table in Release B.
--
-- IF EXISTS + both name variants is deliberate here (an exception to the
-- "keep migration SQL plain" rule): the FK constraint names diverged by how a
-- DB was built. drizzle db:push (dev) names them <table>_organization_id_organizations_id_fk;
-- the migration-built path (CI/prod) left three tables (workflows, eval_sets,
-- eval_schedules) on Postgres-default <table>_organization_id_fkey names. This
-- migration must drop whichever exists on any given DB, so it lists both and
-- tolerates absence. Idempotent by construction; still runs exactly once
-- (version-gated). See CLAUDE.md "dev vs prod FK naming divergence".
ALTER TABLE users              DROP CONSTRAINT IF EXISTS users_organization_id_organizations_id_fk;
ALTER TABLE users              DROP CONSTRAINT IF EXISTS users_organization_id_fkey;
ALTER TABLE projects           DROP CONSTRAINT IF EXISTS projects_organization_id_organizations_id_fk;
ALTER TABLE projects           DROP CONSTRAINT IF EXISTS projects_organization_id_fkey;
ALTER TABLE workflows          DROP CONSTRAINT IF EXISTS workflows_organization_id_organizations_id_fk;
ALTER TABLE workflows          DROP CONSTRAINT IF EXISTS workflows_organization_id_fkey;
ALTER TABLE eval_sets          DROP CONSTRAINT IF EXISTS eval_sets_organization_id_organizations_id_fk;
ALTER TABLE eval_sets          DROP CONSTRAINT IF EXISTS eval_sets_organization_id_fkey;
ALTER TABLE eval_schedules     DROP CONSTRAINT IF EXISTS eval_schedules_organization_id_organizations_id_fk;
ALTER TABLE eval_schedules     DROP CONSTRAINT IF EXISTS eval_schedules_organization_id_fkey;
ALTER TABLE payment_methods    DROP CONSTRAINT IF EXISTS payment_methods_organization_id_organizations_id_fk;
ALTER TABLE payment_methods    DROP CONSTRAINT IF EXISTS payment_methods_organization_id_fkey;
ALTER TABLE payment_histories  DROP CONSTRAINT IF EXISTS payment_histories_organization_id_organizations_id_fk;
ALTER TABLE payment_histories  DROP CONSTRAINT IF EXISTS payment_histories_organization_id_fkey;
ALTER TABLE invite_tokens      DROP CONSTRAINT IF EXISTS invite_tokens_organization_id_organizations_id_fk;
ALTER TABLE invite_tokens      DROP CONSTRAINT IF EXISTS invite_tokens_organization_id_fkey;
ALTER TABLE web_sessions       DROP CONSTRAINT IF EXISTS web_sessions_organization_id_organizations_id_fk;
ALTER TABLE web_sessions       DROP CONSTRAINT IF EXISTS web_sessions_organization_id_fkey;
ALTER TABLE organization_seats DROP CONSTRAINT IF EXISTS organization_seats_organization_id_organizations_id_fk;
ALTER TABLE organization_seats DROP CONSTRAINT IF EXISTS organization_seats_organization_id_fkey;
