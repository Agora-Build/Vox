import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { Pool } from "pg";
import type { OrganizationsProvider as PluginContract } from "../plugins/organizations/server/types";
import { AlreadyMemberError as PluginAME } from "../plugins/organizations/server/types";
import { AlreadyMemberError as CoreAME, isAlreadyMemberError } from "../server/organizations";
import { makeServicesView, loadPlugins, type LoadedPlugins } from "../server/plugins/loader";
import { ServiceRegistry } from "../server/plugins/registry";
import { BUILTIN_PLUGINS } from "../plugins/index";
import { TEST_PLUGIN_DATABASE_URL, ensurePluginTestDatabase } from "./helpers/plugin-test-db";

// The compile-time two-way assignability check between the Core seam
// (server/organizations.ts) and this plugin's mirror (plugins/organizations/server/types.ts)
// lives in `server/plugins/contract-checks.ts`, NOT here: `tsconfig.json` excludes
// `**/*.test.ts` from `npm run check`, and vitest's esbuild transform strips types without
// checking them, so a drift assertion in a `.test.ts` file is never actually type-checked by
// either gate. `contract-checks.ts` sits under `server/**`, which `tsc` does cover.
describe("plugin contract mirrors the Core seam", () => {
  it("AlreadyMemberError shape matches (name + message contract)", () => {
    // Asserted against the LITERAL name, not just against each other: both
    // classes inherited `name = "Error"` before the fix wave, so a
    // plugin-vs-Core comparison alone was vacuously true ("Error" === "Error")
    // and could not see that neither class was identifiable at all.
    expect(new PluginAME().name).toBe("AlreadyMemberError");
    expect(new CoreAME().name).toBe("AlreadyMemberError");
    expect(new PluginAME().name).toBe(new CoreAME().name);
    expect(new PluginAME().message).toBe(new CoreAME().message);
  });

  it("isAlreadyMemberError recognizes the PLUGIN's class, which instanceof cannot", () => {
    // The defect this pins: the plugin throws its own class object, so Core's
    // `instanceof` is structurally false — both Core catch sites would have
    // answered 500 instead of the contract's 400.
    expect(new PluginAME("x") instanceof CoreAME).toBe(false);
    expect(isAlreadyMemberError(new PluginAME("x"))).toBe(true);
    expect(isAlreadyMemberError(new CoreAME("x"))).toBe(true);
    expect(isAlreadyMemberError(new Error("db blip"))).toBe(false);
    expect(isAlreadyMemberError("not an error")).toBe(false);
  });
});

describe("makeServicesView resolves the organizations service", () => {
  it("optional() returns a provided vox.organizations service", () => {
    const registry = new ServiceRegistry();
    const stub: PluginContract = {
      async getMembership() { return null; },
      async getMemberships() { return new Map(); },
      async getOrganization() { return null; },
      async listMembers() { return []; },
      async countMembers() { return 0; },
      async countOrgAdmins() { return 0; },
      async listOrganizations() { return []; },
      async createOrganization() { throw new Error("not implemented"); },
      async updateOrganization() { throw new Error("not implemented"); },
      async setVerified() {},
      async addMember() {},
      async setMemberRole() {},
      async removeMember() {},
      async listOrgSecrets() { return []; },
      async upsertOrgSecret() { throw new Error("not implemented"); },
      async deleteOrgSecret() {},
    };
    registry.provide("vox.organizations", "1.0.0", stub);
    const view = makeServicesView(registry);
    expect(view.optional<PluginContract>("vox.organizations", "^1.0.0")).toBe(stub);
  });
});

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// Builds its own in-process express app (loadPlugins below) rather than hitting the
// live dev server, so the dedicated destructive-test database covers both the schema
// drop and the HTTP assertions consistently. Mirrors tests/plugin-sample-e2e.test.ts.
d("organizations plugin loader e2e", () => {
  let pool: Pool;
  let loaded: LoadedPlugins;
  let app: express.Express;

  beforeAll(async () => {
    await ensurePluginTestDatabase();
    pool = new Pool({ connectionString: TEST_PLUGIN_DATABASE_URL });
    await pool.query(`DROP SCHEMA IF EXISTS plugin_organizations CASCADE`);
    await pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'organizations'`).catch(() => {});
    process.env.VOX_PLUGINS = "organizations";
    app = express();
    app.use(express.json());
    loaded = await loadPlugins(app, pool, BUILTIN_PLUGINS);
  });

  afterAll(async () => {
    await loaded.shutdown();
    await pool.query(`DROP SCHEMA IF EXISTS plugin_organizations CASCADE`);
    await pool.query(`DELETE FROM _plugin_schema_versions WHERE plugin_id = 'organizations'`).catch(() => {});
    delete process.env.VOX_PLUGINS;
    await pool.end();
  });

  it("registers vox.organizations as a resolvable service", () => {
    expect(loaded.services.optional<PluginContract>("vox.organizations", "^1.0.0")).not.toBeNull();
  });

  it("reports health ok (proves manifest, 0001 migration, and activation all load fail-closed-clean)", async () => {
    const health = await request(app).get("/api/plugins/organizations/health");
    expect(health.body).toEqual({ status: "ok" });
  });
});
