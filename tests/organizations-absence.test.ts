import { describe, it, expect, beforeEach } from "vitest";
import { setOrganizations, resetOrganizations, type OrganizationsProvider } from "../server/organizations";
import { membershipFor } from "../server/auth";

// Every method throws — this exercises "provider installed but failing", which
// must stay distinguishable from "provider absent" (see server/organizations.ts).
const failing: OrganizationsProvider = {
  getMembership: async () => { throw new Error("db blip"); },
  getMemberships: async () => { throw new Error("db blip"); },
  getOrganization: async () => { throw new Error("db blip"); },
  listMembers: async () => { throw new Error("db blip"); },
  countMembers: async () => { throw new Error("db blip"); },
  countOrgAdmins: async () => { throw new Error("db blip"); },
  listOrganizations: async () => { throw new Error("db blip"); },
  createOrganization: async () => { throw new Error("db blip"); },
  updateOrganization: async () => { throw new Error("db blip"); },
  setVerified: async () => { throw new Error("db blip"); },
  addMember: async () => { throw new Error("db blip"); },
  setMemberRole: async () => { throw new Error("db blip"); },
  removeMember: async () => { throw new Error("db blip"); },
  listOrgSecrets: async () => { throw new Error("db blip"); },
  upsertOrgSecret: async () => { throw new Error("db blip"); },
  deleteOrgSecret: async () => { throw new Error("db blip"); },
};

describe("absence and failure semantics", () => {
  beforeEach(() => resetOrganizations());

  it("membershipFor returns null under an ABSENT provider (inert, fails closed)", async () => {
    expect(await membershipFor({} as never, 1)).toBeNull();
  });

  it("membershipFor RETHROWS under a FAILING provider — failure must stay distinguishable from 'no org'", async () => {
    setOrganizations(failing);
    await expect(membershipFor({} as never, 1)).rejects.toThrow("db blip");
  });
});
