ALTER TABLE browser_viewer_grants DROP CONSTRAINT IF EXISTS browser_viewer_grants_target_key_key;
ALTER TABLE browser_viewer_grants DROP CONSTRAINT IF EXISTS browser_viewer_grants_target_key_unique;
CREATE INDEX IF NOT EXISTS browser_viewer_grants_target_idx ON browser_viewer_grants (target_key);
