ALTER TABLE "api_keys" ADD COLUMN "revoked_at" timestamp;
ALTER TABLE "api_keys" ADD COLUMN "is_deleted" boolean DEFAULT false NOT NULL;
ALTER TABLE "api_keys" ADD COLUMN "deleted_at" timestamp;
ALTER TABLE "api_keys" ADD COLUMN "last_operation" text;
ALTER TABLE "api_keys" ADD COLUMN "last_operation_at" timestamp;
ALTER TABLE "api_keys" ADD COLUMN "last_operation_by" integer REFERENCES "users"("id");
