import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // _schema_version and _plugin_schema_versions are runtime-owned bookkeeping
  // (created by server/migrate.ts and server/plugins/migrate.ts, deliberately
  // absent from shared/schema.ts). Without this filter `db:push` sees them as
  // unknown tables and offers to DROP them — which hangs a non-interactive
  // `dev-local-run.sh start` on the prompt, or, if accepted, makes the next
  // runner start re-apply migrations that already ran and crash.
  tablesFilter: ["!_schema_version", "!_plugin_schema_versions"],
});
