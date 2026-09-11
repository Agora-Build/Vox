import { describe, it, expect, beforeEach } from "vitest";
import { setOrganizations, resetOrganizations, type OrganizationsProvider } from "../server/organizations";
import { resolveMembership } from "../server/auth";

let calls = 0;
const provider: OrganizationsProvider = {
  getMembership: async (userId: number) => {
    calls++;
    return userId === 1 ? { organizationId: 7, role: "admin" } : null;
  },
  getMemberships: async () => new Map(),
  getOrganization: async () => null,
  listMembers: async () => [],
};

describe("auth membership resolution", () => {
  beforeEach(() => { calls = 0; resetOrganizations(); setOrganizations(provider); });

  it("attaches membership from the provider", async () => {
    const req = {} as never;
    const user = await resolveMembership({ id: 1 } as never, req);
    expect(user!.membership).toEqual({ organizationId: 7, role: "admin" });
  });

  it("attaches null for a user in no org", async () => {
    const user = await resolveMembership({ id: 2 } as never, {} as never);
    expect(user!.membership).toBeNull();
  });

  it("passes undefined through untouched", async () => {
    expect(await resolveMembership(undefined, {} as never)).toBeUndefined();
  });

  it("resolves once per request even when called repeatedly", async () => {
    const req = {} as never;
    await resolveMembership({ id: 1 } as never, req);
    await resolveMembership({ id: 1 } as never, req);
    expect(calls).toBe(1);
  });
});
