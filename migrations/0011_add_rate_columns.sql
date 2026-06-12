-- Cross-chunk eval rates (0..1). Computed by the daemon from turn-level data
-- with denominators from its own per-case sample counts. Nullable: older
-- results and runs without lab.trace sample counts have no rates.
ALTER TABLE eval_results ADD COLUMN response_rate real;
ALTER TABLE eval_results ADD COLUMN interrupt_rate real;
ALTER TABLE eval_results ADD COLUMN false_interrupt_rate real;
