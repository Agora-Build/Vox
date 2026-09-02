ALTER TABLE "region_locations" ADD COLUMN "latitude" double precision;
--> statement-breakpoint
ALTER TABLE "region_locations" ADD COLUMN "longitude" double precision;
--> statement-breakpoint
ALTER TABLE "region_locations" ADD COLUMN "source" varchar(16) NOT NULL DEFAULT 'configured';
--> statement-breakpoint
ALTER TABLE "region_locations" ADD COLUMN "is_mainline" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "region_locations" SET "is_mainline" = true, "latitude" = 47.6062,  "longitude" = -122.3321 WHERE "base_id" = 'na-us-seattle';
--> statement-breakpoint
UPDATE "region_locations" SET "is_mainline" = true, "latitude" = 1.3521,   "longitude" = 103.8198  WHERE "base_id" = 'apac-sg';
--> statement-breakpoint
UPDATE "region_locations" SET "is_mainline" = true, "latitude" = 19.0760,  "longitude" = 72.8777   WHERE "base_id" = 'apac-in-mumbai';
--> statement-breakpoint
UPDATE "region_locations" SET "is_mainline" = true, "latitude" = 50.1109,  "longitude" = 8.6821    WHERE "base_id" = 'eu-de-frankfurt';
--> statement-breakpoint
UPDATE "region_locations" SET "is_mainline" = true, "latitude" = -23.5505, "longitude" = -46.6333  WHERE "base_id" = 'sa-br-saopaulo';
--> statement-breakpoint
ALTER TABLE "eval_agent_tokens" ALTER COLUMN "site_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_agent_tokens" ALTER COLUMN "region" DROP NOT NULL;
--> statement-breakpoint
UPDATE "eval_agent_tokens" SET "site_id" = NULL, "region" = NULL WHERE "dispatch_tier" <> 'public';
--> statement-breakpoint
ALTER TABLE "eval_agents" ALTER COLUMN "site_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "region" varchar(64);
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "location_trust" varchar(16) NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "location_checked_at" timestamp;
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "location_source" jsonb;
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "pending_region" varchar(64);
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "pending_region_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE "eval_agents" SET "site_id" = NULL
  WHERE "token_id" IN (SELECT "id" FROM "eval_agent_tokens" WHERE "dispatch_tier" <> 'public');
--> statement-breakpoint
ALTER TABLE "eval_jobs" ADD COLUMN "location_trust" varchar(16);
--> statement-breakpoint
ALTER TABLE "eval_results" ALTER COLUMN "site_id" DROP NOT NULL;
