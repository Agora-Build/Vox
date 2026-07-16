-- Audio-health metrics for clash results, computed by the runner from each
-- agent's raw audio capture. Makes a silent agent / dead audio pipeline
-- detectable on the completed match record.
ALTER TABLE clash_results ADD COLUMN audio_rms real;
ALTER TABLE clash_results ADD COLUMN talk_time_seconds real;
