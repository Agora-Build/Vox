-- Tools → Analyze (design 2026-09-30): an uploaded recording is analyzed as a
-- hidden job of its own kind. 'eval' = every job before this (the default).
ALTER TABLE eval_jobs ADD COLUMN kind varchar(16) DEFAULT 'eval' NOT NULL;
-- When its uploader deleted an analysis. The row stays (its result and file
-- are gone) so the daily upload cap still counts it.
ALTER TABLE eval_jobs ADD COLUMN deleted_at timestamp;
-- Where an analyzed recording was made, as the uploader stated it (a region
-- location base id). Set only for analyze results; their site_id stays NULL,
-- because no Vox agent measured the conversation from a site.
ALTER TABLE eval_results ADD COLUMN recording_region varchar(64);
