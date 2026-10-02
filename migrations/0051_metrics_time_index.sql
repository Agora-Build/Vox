-- Bound historical detail lookups and their density probes by the viewed dates.
-- Registered as a restart-safe, nontransactional index build in server/migrate.ts.
CREATE INDEX CONCURRENTLY eval_results_created_at_idx ON public.eval_results (created_at);
