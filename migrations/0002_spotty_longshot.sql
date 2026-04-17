ALTER TABLE "clash_results" ADD COLUMN "response_latency_p95" integer;--> statement-breakpoint
ALTER TABLE "clash_results" ADD COLUMN "interrupt_latency_p95" integer;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "response_latency_p95" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "interrupt_latency_p95" integer NOT NULL DEFAULT 0;