-- Per-agent SIM report generation (server/sim-carrier.ts). Each SIM recompute
-- or clear takes the next generation when it starts; a recompute writes its
-- result only if its generation is still the row's latest, so of two
-- overlapping reports the newer one wins whichever finishes last — across
-- Core processes too. Negative = a recompute is in flight (its generation
-- negated); positive = settled. Core-internal.
ALTER TABLE eval_agents ADD COLUMN sim_report_gen integer NOT NULL DEFAULT 0;
