-- Core's opaque "this job's settlement needs nothing more" marker (#97). Set
-- after marketplace.settle() resolves for a terminal job; the reap-settle
-- sweep skips marked rows, so already-settled jobs no longer occupy its
-- batch and push unsettled ones out of the lookback window. Core never
-- interprets settlement itself — the plugin decides; Core only records that
-- its call returned. NULL for every existing row: they stay sweep-eligible
-- until they age out of the (15-minute) window, exactly as before.
ALTER TABLE eval_jobs ADD COLUMN settlement_done_at timestamp;
