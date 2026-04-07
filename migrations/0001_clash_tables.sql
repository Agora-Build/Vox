CREATE TYPE "public"."clash_event_status" AS ENUM('upcoming', 'live', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."clash_runner_state" AS ENUM('idle', 'assigned', 'running', 'draining');--> statement-breakpoint
CREATE TYPE "public"."clash_status" AS ENUM('pending', 'starting', 'live', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "clash_agent_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_id" integer NOT NULL,
	"provider_id" varchar(12),
	"agent_url" text NOT NULL,
	"setup_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"adapter_type" text DEFAULT 'browser' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clash_elo_ratings" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_profile_id" integer NOT NULL,
	"rating" integer DEFAULT 1500 NOT NULL,
	"match_count" integer DEFAULT 0 NOT NULL,
	"win_count" integer DEFAULT 0 NOT NULL,
	"loss_count" integer DEFAULT 0 NOT NULL,
	"draw_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "clash_elo_ratings_agent_profile_id_unique" UNIQUE("agent_profile_id")
);
--> statement-breakpoint
CREATE TABLE "clash_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" integer NOT NULL,
	"region" "region" NOT NULL,
	"status" "clash_event_status" DEFAULT 'upcoming' NOT NULL,
	"visibility" "visibility" DEFAULT 'public' NOT NULL,
	"scheduled_at" timestamp,
	"agora_channel_name" text,
	"moderator_agent_id" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clash_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"match_order" integer DEFAULT 1 NOT NULL,
	"agent_a_profile_id" integer NOT NULL,
	"agent_b_profile_id" integer NOT NULL,
	"status" "clash_status" DEFAULT 'pending' NOT NULL,
	"topic" text NOT NULL,
	"max_duration_seconds" integer DEFAULT 300 NOT NULL,
	"winner_id" integer,
	"runner_id" text,
	"recording_url" text,
	"duration_seconds" integer,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clash_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"clash_match_id" integer NOT NULL,
	"agent_profile_id" integer NOT NULL,
	"provider_id" varchar(12),
	"response_latency_median" integer,
	"response_latency_sd" real,
	"interrupt_latency_median" integer,
	"interrupt_latency_sd" real,
	"ttft_median" integer,
	"turn_count" integer,
	"overlap_percent" real,
	"raw_data" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clash_runner_issued_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"region" "region" NOT NULL,
	"created_by" integer NOT NULL,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "clash_runner_issued_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "clash_runner_pool" (
	"id" serial PRIMARY KEY NOT NULL,
	"runner_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"region" "region" NOT NULL,
	"state" "clash_runner_state" DEFAULT 'idle' NOT NULL,
	"current_match_id" integer,
	"last_heartbeat_at" timestamp,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "clash_runner_pool_runner_id_unique" UNIQUE("runner_id"),
	CONSTRAINT "clash_runner_pool_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "clash_runner_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"clash_match_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "clash_runner_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "clash_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_name" text NOT NULL,
	"created_by" integer NOT NULL,
	"matchups" jsonb NOT NULL,
	"region" "region" NOT NULL,
	"max_duration_seconds" integer DEFAULT 300 NOT NULL,
	"scheduled_at" timestamp,
	"cron_expression" varchar(100),
	"is_enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clash_transcripts" (
	"id" serial PRIMARY KEY NOT NULL,
	"clash_match_id" integer NOT NULL,
	"speaker_label" text NOT NULL,
	"text" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer,
	"confidence" real,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clash_agent_profiles" ADD CONSTRAINT "clash_agent_profiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_agent_profiles" ADD CONSTRAINT "clash_agent_profiles_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_elo_ratings" ADD CONSTRAINT "clash_elo_ratings_agent_profile_id_clash_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."clash_agent_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_events" ADD CONSTRAINT "clash_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_matches" ADD CONSTRAINT "clash_matches_event_id_clash_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."clash_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_matches" ADD CONSTRAINT "clash_matches_agent_a_profile_id_clash_agent_profiles_id_fk" FOREIGN KEY ("agent_a_profile_id") REFERENCES "public"."clash_agent_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_matches" ADD CONSTRAINT "clash_matches_agent_b_profile_id_clash_agent_profiles_id_fk" FOREIGN KEY ("agent_b_profile_id") REFERENCES "public"."clash_agent_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_matches" ADD CONSTRAINT "clash_matches_winner_id_clash_agent_profiles_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."clash_agent_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_results" ADD CONSTRAINT "clash_results_clash_match_id_clash_matches_id_fk" FOREIGN KEY ("clash_match_id") REFERENCES "public"."clash_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_results" ADD CONSTRAINT "clash_results_agent_profile_id_clash_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."clash_agent_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_results" ADD CONSTRAINT "clash_results_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_runner_issued_tokens" ADD CONSTRAINT "clash_runner_issued_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_runner_pool" ADD CONSTRAINT "clash_runner_pool_current_match_id_clash_matches_id_fk" FOREIGN KEY ("current_match_id") REFERENCES "public"."clash_matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_runner_tokens" ADD CONSTRAINT "clash_runner_tokens_clash_match_id_clash_matches_id_fk" FOREIGN KEY ("clash_match_id") REFERENCES "public"."clash_matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_schedules" ADD CONSTRAINT "clash_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clash_transcripts" ADD CONSTRAINT "clash_transcripts_clash_match_id_clash_matches_id_fk" FOREIGN KEY ("clash_match_id") REFERENCES "public"."clash_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clash_events_status_idx" ON "clash_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clash_matches_status_idx" ON "clash_matches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clash_matches_event_idx" ON "clash_matches" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "clash_runner_pool_state_idx" ON "clash_runner_pool" USING btree ("state");--> statement-breakpoint
CREATE INDEX "clash_schedules_enabled_idx" ON "clash_schedules" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "clash_transcripts_match_idx" ON "clash_transcripts" USING btree ("clash_match_id");
