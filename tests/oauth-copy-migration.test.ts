import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "fs";
import { runPluginMigrations } from "../server/plugins/migrate";
import { parseManifest } from "../server/plugins/manifest";
import { prepareIsolatedCoreDb } from "./helpers/isolated-core-db";

// The oauth plugin's 0002_copy_from_core migration, run the way production runs
// it: against a fully migrated Core database that already holds GitHub and
// Google links on public.users. Every link must arrive intact, or sign-in would
// silently hand a returning user a brand-new account.

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d("oauth plugin — copying existing links out of Core", () => {
  let pool: Pool;

  beforeAll(async () => {
    const url = await prepareIsolatedCoreDb(process.env.DATABASE_URL!, "vox_test_oauth_copy");
    pool = new Pool({ connectionString: url });

    // Core as it stands before the plugin: some users linked, some not.
    const add = (username: string, githubId: string | null, googleId: string | null) =>
      pool.query(
        `INSERT INTO users (username, email, plan, is_admin, is_enabled, github_id, google_id)
         VALUES ($1, $1 || '@example.com', 'basic', false, true, $2, $3)`,
        [username, githubId, googleId],
      );
    await add("gh_only", "1001", null);
    await add("google_only", null, "g-2002");
    await add("both", "1003", "g-2004");
    await add("neither", null, null);

    const manifest = parseManifest(JSON.parse(readFileSync("plugins/oauth/vox.plugin.json", "utf-8")));
    await runPluginMigrations(pool, [manifest], "plugins");
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("copies every GitHub and Google link, to the right user, and nothing else", async () => {
    const { rows } = await pool.query(`
      SELECT i.provider, i.subject, u.username
      FROM plugin_oauth.identities i JOIN users u ON u.id = i.user_id
      ORDER BY i.provider, i.subject`);
    expect(rows).toEqual([
      { provider: "github", subject: "1001", username: "gh_only" },
      { provider: "github", subject: "1003", username: "both" },
      { provider: "google", subject: "g-2002", username: "google_only" },
      { provider: "google", subject: "g-2004", username: "both" },
    ]);
  });

  it("records its migrations as applied, so the copy (2) never runs twice", async () => {
    const { rows } = await pool.query(
      `SELECT version FROM _plugin_schema_versions WHERE plugin_id = 'oauth' ORDER BY version`);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]); // 3 = used_states
  });
});
