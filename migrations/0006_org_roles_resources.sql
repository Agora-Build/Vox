-- Org role enum (replaces isOrgAdmin boolean)
CREATE TYPE "org_role" AS ENUM ('owner', 'admin', 'member');--> statement-breakpoint

-- Add orgRole to users, drop isOrgAdmin
ALTER TABLE "users" ADD COLUMN "org_role" "org_role";--> statement-breakpoint
UPDATE "users" SET "org_role" = 'admin' WHERE "is_org_admin" = true AND "organization_id" IS NOT NULL;--> statement-breakpoint
UPDATE "users" SET "org_role" = 'member' WHERE "is_org_admin" = false AND "organization_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_org_admin";--> statement-breakpoint

-- Add organizationId to resource tables
ALTER TABLE "workflows" ADD COLUMN "organization_id" integer REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "eval_sets" ADD COLUMN "organization_id" integer REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "eval_schedules" ADD COLUMN "organization_id" integer REFERENCES "organizations"("id");--> statement-breakpoint

-- Org secrets table
CREATE TABLE "org_secrets" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "encrypted_value" text NOT NULL,
  "created_by" integer REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "org_secrets_org_name_idx" ON "org_secrets" ("organization_id", "name");