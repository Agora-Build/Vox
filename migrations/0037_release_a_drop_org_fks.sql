-- Release A: drop the 10 org FK constraints on Core tables.
-- org ids become opaque integers on Core; organizations/org_secrets tables remain.
-- org_secrets keeps its FK — it travels with its table in Release B.
ALTER TABLE users             DROP CONSTRAINT users_organization_id_organizations_id_fk;
ALTER TABLE projects          DROP CONSTRAINT projects_organization_id_organizations_id_fk;
ALTER TABLE workflows         DROP CONSTRAINT workflows_organization_id_organizations_id_fk;
ALTER TABLE eval_sets         DROP CONSTRAINT eval_sets_organization_id_organizations_id_fk;
ALTER TABLE eval_schedules    DROP CONSTRAINT eval_schedules_organization_id_organizations_id_fk;
ALTER TABLE payment_methods   DROP CONSTRAINT payment_methods_organization_id_organizations_id_fk;
ALTER TABLE payment_histories DROP CONSTRAINT payment_histories_organization_id_organizations_id_fk;
ALTER TABLE invite_tokens     DROP CONSTRAINT invite_tokens_organization_id_organizations_id_fk;
ALTER TABLE web_sessions      DROP CONSTRAINT web_sessions_organization_id_organizations_id_fk;
ALTER TABLE organization_seats DROP CONSTRAINT organization_seats_organization_id_organizations_id_fk;
