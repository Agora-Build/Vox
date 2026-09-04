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
  // _plugin_schema_versions is runtime-owned bookkeeping (created by
  // server/plugins/migrate.ts, deliberately absent from shared/schema.ts).
  // Without this filter `db:push` sees it as an unknown table and DROPS it,
  // which makes the next startup re-run every plugin migration into its
  // still-populated plugin schema and crash with "relation already exists".
  tablesFilter: ["!_plugin_schema_versions"],
});
