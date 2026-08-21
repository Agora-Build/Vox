ALTER TABLE "secrets" ADD COLUMN "broker_type" text;--> statement-breakpoint
ALTER TABLE "org_secrets" ADD COLUMN "broker_type" text;--> statement-breakpoint
UPDATE "secrets" SET "broker_type" = 'auth-session' WHERE "class" = 'protected';--> statement-breakpoint
UPDATE "org_secrets" SET "broker_type" = 'auth-session' WHERE "class" = 'protected';--> statement-breakpoint
ALTER TABLE "secrets" DROP COLUMN "class";--> statement-breakpoint
ALTER TABLE "org_secrets" DROP COLUMN "class";--> statement-breakpoint
DROP TYPE "secret_class";--> statement-breakpoint
CREATE TYPE "broker_state" AS ENUM('idle', 'offline', 'busy');--> statement-breakpoint
CREATE TABLE "broker_registration_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"broker_type" text NOT NULL,
	"created_by" integer NOT NULL,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "broker_registration_tokens_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
CREATE TABLE "brokers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_id" integer NOT NULL,
	"broker_type" text NOT NULL,
	"url" text NOT NULL,
	"state" "broker_state" DEFAULT 'offline' NOT NULL,
	"current_lease_id" text,
	"last_seen_at" timestamp,
	"observed_ip" text,
	"observed_ip_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "broker_registration_tokens" ADD CONSTRAINT "broker_registration_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brokers" ADD CONSTRAINT "brokers_token_id_broker_registration_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."broker_registration_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brokers_type_state_idx" ON "brokers" USING btree ("broker_type","state");
