-- Tools → Analyze (design 2026-09-30): an uploaded recording is analyzed as a
-- hidden job of its own kind. 'eval' = every job before this (the default).
ALTER TABLE eval_jobs ADD COLUMN kind varchar(16) DEFAULT 'eval' NOT NULL;
-- Where an analyzed recording was made, as the uploader stated it (a region
-- location base id). Set only for analyze results; their site_id stays NULL,
-- because no Vox agent measured the conversation from a site.
ALTER TABLE eval_results ADD COLUMN recording_region varchar(64);
