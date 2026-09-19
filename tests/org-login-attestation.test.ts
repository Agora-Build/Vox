//
// The shared-tier ATTESTATION GATE, org path. `areLoginSecretsAttested` is the
// predicate behind routes.ts's 403 "Shared dispatch requires dedicated
// test-account credentials" — the check that stops a real (non-test) login
// credential from being minted into a session for a stranger's marketplace
// agent.
//
// Its org arm used to read `org_secrets` straight out of storage; it now
// resolves through the `vox.organizations` seam (Ruling F). tests/session-
// dispatch.test.ts already covers the gate end-to-end over PERSONAL secrets
// (cases 4b/5) — nothing covered the ORG arm, which is exactly the arm that
// moved. These cases pin its verdicts directly, fence-suite style: seed org
// secrets through the seam's ciphertext-only writer, then assert the verdict.
//
// Verdicts must match the pre-seam `storage.areLoginSecretsAttested` exactly:
// EVERY named secret must exist AND be login-class (brokerType
// "auth-session") AND be attested isTestAccount.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { storage, encryptValue, db } from "../server/storage";
import { areLoginSecretsAttested } from "../server/auth-session";
import { setOrganizations, resetOrganizations } from "../server/organizations";
import { setupOrganizationsDb, type OrgsHarness } from "./helpers/organizations-db";
import { secrets, users } from "../shared/schema";
import { eq } from "drizzle-orm";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const stamp = Date.now();
const EMAIL = `LA_EMAIL_${stamp}`;
const PASSWORD = `LA_PASSWORD_${stamp}`;
const UNATTESTED = `LA_UNATTESTED_${stamp}`;
const RUNTIME = `LA_RUNTIME_${stamp}`;
const ABSENT = `LA_NEVER_CREATED_${stamp}`;

d("shared-tier login-secret attestation (org arm via the seam)", () => {
  let h: OrgsHarness;
  let orgId: number, member: any, solo: any;

  beforeAll(async () => {
    // The real plugin provider on the dedicated plugin test DB — post-flip the
    // org's secrets live in the plugin's schema, so that is where they are
    // seeded; the personal arm's rows stay Core-side (dev DB), which is the
    // whole point of the last case below.
    h = await setupOrganizationsDb();
    setOrganizations(h.provider);

    const orgRow = await h.db.query<{ id: number }>(
      "INSERT INTO organizations (name) VALUES ($1) RETURNING id", [`la-org-${stamp}`]);
    orgId = orgRow.rows[0].id;
    member = await storage.createUser({
      username: `la-m-${stamp}`, email: `la-m-${stamp}@test.local`,
    } as any);
    await h.provider.addMember(orgId, member.id, "member");
    solo = await storage.createUser({
      username: `la-s-${stamp}`, email: `la-s-${stamp}@test.local`,
    } as any);

    // Seeded through the ciphertext-only writer the seam uses, not a raw insert.
    const row = (name: string, brokerType: string | null, isTestAccount: boolean) =>
      h.provider.upsertOrgSecret(orgId, {
        name, encryptedValue: encryptValue(`v-${name}`), brokerType, isTestAccount, createdBy: member.id,
      });

    await row(EMAIL, "auth-session", true);      // login-class, attested
    await row(PASSWORD, "auth-session", true);   // login-class, attested
    await row(UNATTESTED, "auth-session", false); // login-class, NOT attested
    await row(RUNTIME, null, true);               // attested but NOT login-class

    // The personal arm is unchanged Core code; one row proves this task did not
    // disturb it while re-pointing only the org arm.
    await storage.createOrUpdateSecret(solo.id, EMAIL, encryptValue("p-email"), {
      brokerType: "auth-session", isTestAccount: true,
    });
    await storage.createOrUpdateSecret(solo.id, PASSWORD, encryptValue("p-password"), {
      brokerType: "auth-session", isTestAccount: false,
    });
  });

  afterAll(async () => {
    if (!hasDb) return;
    // Core-side rows only; the plugin-side org + secrets die with the schema.
    if (solo) await db.delete(secrets).where(eq(secrets.userId, solo.id));
    for (const u of [member, solo]) {
      if (u) await db.delete(users).where(eq(users.id, u.id));
    }
    resetOrganizations();
    await h.pool.query(`DROP SCHEMA IF EXISTS "${h.schema}" CASCADE`);
    await h.pool.end();
  });

  it("both login secrets attested -> gate passes", async () => {
    await expect(areLoginSecretsAttested({ organizationId: orgId }, [EMAIL, PASSWORD]))
      .resolves.toBe(true);
  });

  it("ALL-names semantics: one unattested name fails the whole set", async () => {
    await expect(areLoginSecretsAttested({ organizationId: orgId }, [EMAIL, UNATTESTED]))
      .resolves.toBe(false);
  });

  it("a name with no row at all fails — absence is never attestation", async () => {
    await expect(areLoginSecretsAttested({ organizationId: orgId }, [EMAIL, ABSENT]))
      .resolves.toBe(false);
  });

  it("isTestAccount alone is not enough: a RUNTIME-class row fails the gate", async () => {
    // Guards the brokerType half of the predicate, which a name+isTestAccount
    // check alone would silently drop.
    await expect(areLoginSecretsAttested({ organizationId: orgId }, [RUNTIME]))
      .resolves.toBe(false);
  });

  it("absent provider -> NOT attested (fails CLOSED, never a throw)", async () => {
    resetOrganizations();
    try {
      // Same names that pass above: the verdict flips solely because the org's
      // rows became unreachable, so a credential-injected job can never reach a
      // shared agent on an unanswerable attestation question.
      await expect(areLoginSecretsAttested({ organizationId: orgId }, [EMAIL, PASSWORD]))
        .resolves.toBe(false);
    } finally {
      setOrganizations(h.provider);
    }
  });

  it("the PERSONAL arm is untouched by the re-point — and needs no provider", async () => {
    await expect(areLoginSecretsAttested({ userId: solo.id }, [EMAIL])).resolves.toBe(true);
    await expect(areLoginSecretsAttested({ userId: solo.id }, [EMAIL, PASSWORD])).resolves.toBe(false);
    resetOrganizations();
    try {
      // Personal secrets are Core-owned: provider absence must NOT affect them.
      await expect(areLoginSecretsAttested({ userId: solo.id }, [EMAIL])).resolves.toBe(true);
    } finally {
      setOrganizations(h.provider);
    }
  });
});
