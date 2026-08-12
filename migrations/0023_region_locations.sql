CREATE TABLE "region_locations" (
  "id" serial PRIMARY KEY NOT NULL,
  "base_id" varchar(64) NOT NULL,
  "display_name" text NOT NULL,
  "city" text NOT NULL,
  "country_code" varchar(2) NOT NULL,
  "country_name" text NOT NULL,
  "macro_region_code" varchar(16) NOT NULL,
  "macro_region_name" text NOT NULL,
  "next_sequence" integer DEFAULT 1 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "region_locations_base_id_unique" UNIQUE("base_id")
);
--> statement-breakpoint
CREATE INDEX "region_locations_macro_idx" ON "region_locations" USING btree ("macro_region_code");
--> statement-breakpoint
CREATE INDEX "region_locations_active_idx" ON "region_locations" USING btree ("is_active");
--> statement-breakpoint
INSERT INTO "region_locations"
  ("base_id", "display_name", "city", "country_code", "country_name", "macro_region_code", "macro_region_name", "next_sequence", "is_active")
VALUES
  ('na-us-seattle', 'Seattle', 'Seattle', 'US', 'United States', 'na', 'North America', 2, true),
  ('apac-sg', 'Singapore', 'Singapore', 'SG', 'Singapore', 'apac', 'Asia Pacific', 2, true),
  ('apac-in-mumbai', 'Mumbai', 'Mumbai', 'IN', 'India', 'apac', 'Asia Pacific', 1, true),
  ('eu-de-frankfurt', 'Frankfurt', 'Frankfurt', 'DE', 'Germany', 'eu', 'Europe', 2, true),
  ('sa-br-saopaulo', 'Sao Paulo', 'Sao Paulo', 'BR', 'Brazil', 'sa', 'South America', 2, true);
--> statement-breakpoint
ALTER TABLE "eval_agent_tokens" ALTER COLUMN "region" TYPE varchar(64) USING CASE "region"::text WHEN 'na' THEN 'na-us-seattle-01' WHEN 'apac' THEN 'apac-sg-01' WHEN 'eu' THEN 'eu-de-frankfurt-01' WHEN 'sa' THEN 'sa-br-saopaulo-01' ELSE "region"::text END;
--> statement-breakpoint
ALTER TABLE "eval_agents" ALTER COLUMN "region" TYPE varchar(64) USING CASE "region"::text WHEN 'na' THEN 'na-us-seattle-01' WHEN 'apac' THEN 'apac-sg-01' WHEN 'eu' THEN 'eu-de-frankfurt-01' WHEN 'sa' THEN 'sa-br-saopaulo-01' ELSE "region"::text END;
--> statement-breakpoint
ALTER TABLE "eval_schedules" ALTER COLUMN "region" TYPE varchar(64) USING CASE "region"::text WHEN 'na' THEN 'na-us-seattle-01' WHEN 'apac' THEN 'apac-sg-01' WHEN 'eu' THEN 'eu-de-frankfurt-01' WHEN 'sa' THEN 'sa-br-saopaulo-01' ELSE "region"::text END;
--> statement-breakpoint
ALTER TABLE "eval_jobs" ALTER COLUMN "region" TYPE varchar(64) USING CASE "region"::text WHEN 'na' THEN 'na-us-seattle-01' WHEN 'apac' THEN 'apac-sg-01' WHEN 'eu' THEN 'eu-de-frankfurt-01' WHEN 'sa' THEN 'sa-br-saopaulo-01' ELSE "region"::text END;
--> statement-breakpoint
ALTER TABLE "eval_results" ALTER COLUMN "region" TYPE varchar(64) USING CASE "region"::text WHEN 'na' THEN 'na-us-seattle-01' WHEN 'apac' THEN 'apac-sg-01' WHEN 'eu' THEN 'eu-de-frankfurt-01' WHEN 'sa' THEN 'sa-br-saopaulo-01' ELSE "region"::text END;
--> statement-breakpoint
ALTER TABLE "clash_events" ALTER COLUMN "region" TYPE varchar(64) USING CASE "region"::text WHEN 'na' THEN 'na-us-seattle-01' WHEN 'apac' THEN 'apac-sg-01' WHEN 'eu' THEN 'eu-de-frankfurt-01' WHEN 'sa' THEN 'sa-br-saopaulo-01' ELSE "region"::text END;
--> statement-breakpoint
ALTER TABLE "clash_runner_issued_tokens" ALTER COLUMN "region" TYPE varchar(64) USING CASE "region"::text WHEN 'na' THEN 'na-us-seattle-01' WHEN 'apac' THEN 'apac-sg-01' WHEN 'eu' THEN 'eu-de-frankfurt-01' WHEN 'sa' THEN 'sa-br-saopaulo-01' ELSE "region"::text END;
--> statement-breakpoint
ALTER TABLE "clash_runner_pool" ALTER COLUMN "region" TYPE varchar(64) USING CASE "region"::text WHEN 'na' THEN 'na-us-seattle-01' WHEN 'apac' THEN 'apac-sg-01' WHEN 'eu' THEN 'eu-de-frankfurt-01' WHEN 'sa' THEN 'sa-br-saopaulo-01' ELSE "region"::text END;
--> statement-breakpoint
ALTER TABLE "clash_schedules" ALTER COLUMN "region" TYPE varchar(64) USING CASE "region"::text WHEN 'na' THEN 'na-us-seattle-01' WHEN 'apac' THEN 'apac-sg-01' WHEN 'eu' THEN 'eu-de-frankfurt-01' WHEN 'sa' THEN 'sa-br-saopaulo-01' ELSE "region"::text END;
--> statement-breakpoint
DO $$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM (
    SELECT "region" FROM "eval_agent_tokens"
    UNION ALL SELECT "region" FROM "eval_agents"
    UNION ALL SELECT "region" FROM "eval_schedules"
    UNION ALL SELECT "region" FROM "eval_jobs"
    UNION ALL SELECT "region" FROM "eval_results"
    UNION ALL SELECT "region" FROM "clash_events"
    UNION ALL SELECT "region" FROM "clash_runner_issued_tokens"
    UNION ALL SELECT "region" FROM "clash_runner_pool"
    UNION ALL SELECT "region" FROM "clash_schedules"
  ) migrated
  WHERE migrated."region" IN ('na', 'apac', 'eu', 'sa')
     OR NOT EXISTS (
       SELECT 1
       FROM "region_locations" location
       WHERE migrated."region" ~ ('^' || location."base_id" || '-[0-9]+$')
     );

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'region migration left % broad or unrecognized region values', invalid_count;
  END IF;
END $$;
--> statement-breakpoint
WITH all_regions AS (
  SELECT "region" FROM "eval_agent_tokens"
  UNION ALL SELECT "region" FROM "eval_agents"
  UNION ALL SELECT "region" FROM "eval_schedules"
  UNION ALL SELECT "region" FROM "eval_jobs"
  UNION ALL SELECT "region" FROM "eval_results"
  UNION ALL SELECT "region" FROM "clash_events"
  UNION ALL SELECT "region" FROM "clash_runner_issued_tokens"
  UNION ALL SELECT "region" FROM "clash_runner_pool"
  UNION ALL SELECT "region" FROM "clash_schedules"
),
max_sequences AS (
  SELECT
    location."id",
    max(substring(all_regions."region" from '([0-9]+)$')::integer) AS max_sequence
  FROM "region_locations" location
  LEFT JOIN all_regions
    ON all_regions."region" ~ ('^' || location."base_id" || '-[0-9]+$')
  GROUP BY location."id"
)
UPDATE "region_locations" location
SET "next_sequence" = greatest(location."next_sequence", coalesce(max_sequences.max_sequence + 1, 1)),
    "updated_at" = now()
FROM max_sequences
WHERE location."id" = max_sequences."id";
--> statement-breakpoint
DROP TYPE "region";
