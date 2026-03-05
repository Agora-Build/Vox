ALTER TABLE "users" ADD COLUMN "github_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_github_id_unique" UNIQUE("github_id");