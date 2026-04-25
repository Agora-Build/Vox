CREATE TABLE "user_storage_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"s3_endpoint" text NOT NULL,
	"s3_bucket" text NOT NULL,
	"s3_region" varchar(50) DEFAULT 'auto' NOT NULL,
	"s3_access_key_id" text NOT NULL,
	"s3_secret_access_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_storage_config_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "artifact_url" text;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "artifact_files" jsonb;--> statement-breakpoint
ALTER TABLE "user_storage_config" ADD CONSTRAINT "user_storage_config_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;