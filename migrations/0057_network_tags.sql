-- Network tags (designs/2026-10-22-network-tags-design.md "Data model"):
-- hand-set tags on the eval flow (the TARGET under test) and the eval agent
-- (our VANTAGE POINT), the flow's number-lookup answer for `line`, the
-- per-number lookup cache, and the frozen per-job tag snapshot (null for
-- jobs claimed before this release).
ALTER TABLE eval_flows ADD COLUMN tags jsonb NOT NULL DEFAULT '[]';
ALTER TABLE eval_flows ADD COLUMN line_lookup jsonb;
ALTER TABLE eval_agents ADD COLUMN tags jsonb NOT NULL DEFAULT '[]';
ALTER TABLE eval_agents ADD COLUMN link_type varchar(16);
ALTER TABLE eval_jobs ADD COLUMN tags jsonb;

CREATE TABLE number_lookups (
  number varchar(20) PRIMARY KEY,
  provider varchar(16) NOT NULL,
  carrier_name text,
  line_type varchar(32),
  value varchar(48),
  looked_up_at timestamp NOT NULL DEFAULT now()
);
