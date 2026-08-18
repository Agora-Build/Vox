-- Phase C (zero-trust credential injection) schema foundation:
-- - secret_class distinguishes 'runtime' secrets (may reach an eval agent via
--   getSecretsForJob) from 'login' secrets (Core-only, structurally excluded);
--   is_test_account is the owner's attestation that a login identity is a
--   dedicated, disposable test account, required before shared-tier dispatch
--   of session workflows.
-- - eval_agents.observed_ip / observed_ip_at record the Core-observed egress IP
--   at register/heartbeat time (Layer-2/3 foundation for risk tracking).
-- - web_sessions caches Core-minted login sessions (Playwright storageState)
--   per owner scope (user XOR org) + platform; the broker sidecar mints them
--   and agents only ever see the decrypted storageState via
--   GET /api/eval-agent/jobs/:id/session.
CREATE TYPE "public"."secret_class" AS ENUM('runtime', 'login');--> statement-breakpoint
CREATE TYPE "public"."web_session_status" AS ENUM('minting', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"organization_id" integer,
	"platform_id" text NOT NULL,
	"status" "public"."web_session_status" NOT NULL,
	"encrypted_storage_state" text,
	"minted_at" timestamp,
	"expires_at" timestamp,
	"last_error" text,
	"mint_started_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "observed_ip" text;--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "observed_ip_at" timestamp;--> statement-breakpoint
ALTER TABLE "org_secrets" ADD COLUMN "class" "public"."secret_class" DEFAULT 'runtime' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_secrets" ADD COLUMN "is_test_account" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "class" "public"."secret_class" DEFAULT 'runtime' NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "is_test_account" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "web_sessions_user_platform_idx" ON "web_sessions" USING btree ("user_id","platform_id") WHERE organization_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "web_sessions_org_platform_idx" ON "web_sessions" USING btree ("organization_id","platform_id") WHERE user_id IS NULL;--> statement-breakpoint
-- A row carrying both/neither scope key falls outside both partial unique
-- indexes above, so ON CONFLICT never fires and the single-flight mint claim
-- silently stops deduplicating. Make that state unrepresentable at the DB level.
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_scope_xor_ck" CHECK (num_nonnulls(user_id, organization_id) = 1);
