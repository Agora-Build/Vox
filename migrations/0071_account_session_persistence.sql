ALTER TABLE "web_sessions" ADD COLUMN "account_session_key" text;
--> statement-breakpoint
CREATE TABLE "account_session_checkpoints" (
	"session_key" text NOT NULL,
	"generation" integer NOT NULL,
	"checkpoint_id" text NOT NULL,
	"execution_key" text NOT NULL,
	"sequence" bigint NOT NULL,
	"content_hash" text NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_session_checkpoints_session_key_generation_checkpoint_id_pk" PRIMARY KEY("session_key","generation","checkpoint_id"),
	CONSTRAINT "account_session_checkpoints_sequence_ck" CHECK ("account_session_checkpoints"."generation" > 0 AND "account_session_checkpoints"."sequence" BETWEEN 1 AND 9999999999)
);
--> statement-breakpoint
CREATE TABLE "account_sessions" (
	"session_key" text PRIMARY KEY NOT NULL,
	"user_id" integer,
	"organization_id" integer,
	"source" text NOT NULL,
	"platform_id" text NOT NULL,
	"tenant_key" text NOT NULL,
	"credential_revision" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"refresh_owner" text,
	"refresh_expires_at" timestamp with time zone,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"encrypted_storage_state" text,
	"storage_format" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_sessions_scope_ck" CHECK (num_nonnulls("account_sessions"."user_id", "account_sessions"."organization_id") = 1),
	CONSTRAINT "account_sessions_source_ck" CHECK ("account_sessions"."source" IN ('runtime', 'brokered')),
	CONSTRAINT "account_sessions_generation_ck" CHECK ("account_sessions"."generation" >= 0 AND "account_sessions"."last_sequence" BETWEEN 0 AND 9999999999),
	CONSTRAINT "account_sessions_refresh_ck" CHECK (("account_sessions"."refresh_owner" IS NULL) = ("account_sessions"."refresh_expires_at" IS NULL)),
	CONSTRAINT "account_sessions_state_ck" CHECK (("account_sessions"."encrypted_storage_state" IS NULL) = ("account_sessions"."storage_format" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "account_session_checkpoints" ADD CONSTRAINT "account_session_checkpoints_session_key_account_sessions_session_key_fk" FOREIGN KEY ("session_key") REFERENCES "public"."account_sessions"("session_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_sessions" ADD CONSTRAINT "account_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_session_checkpoints_sequence_idx" ON "account_session_checkpoints" USING btree ("session_key","generation","sequence");
--> statement-breakpoint
CREATE INDEX "account_sessions_updated_at_idx" ON "account_sessions" USING btree ("updated_at");
--> statement-breakpoint
CREATE INDEX "account_session_checkpoints_committed_at_idx" ON "account_session_checkpoints" USING btree ("committed_at");
