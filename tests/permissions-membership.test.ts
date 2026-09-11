import { describe, it, expect } from "vitest";
import { canAccessResource, isOwnerOrOrgManager, hasOrg, canEditResource } from "../server/permissions";

const owner  = { id: 1, isAdmin: false, membership: { organizationId: 7, role: "owner"  as const } };
const member = { id: 2, isAdmin: false, membership: { organizationId: 7, role: "member" as const } };
const outsider = { id: 3, isAdmin: false, membership: null };
const otherOrg = { id: 4, isAdmin: false, membership: { organizationId: 8, role: "admin" as const } };
const admin = { id: 5, isAdmin: true, membership: null };

const orgResource = { ownerId: 2, organizationId: 7, visibility: "private" };
const personal    = { ownerId: 2, organizationId: null, visibility: "private" };

describe("permissions over membership", () => {
  it("grants org members access to an org resource", () => {
    expect(canAccessResource(member, orgResource)).toBe(true);
    expect(canAccessResource(owner, orgResource)).toBe(true);
  });

  it("denies a different org and a user with no org", () => {
    expect(canAccessResource(otherOrg, orgResource)).toBe(false);
    expect(canAccessResource(outsider, orgResource)).toBe(false);
  });

  it("treats org managers as editors of an org resource", () => {
    expect(isOwnerOrOrgManager(owner, orgResource)).toBe(true);
    expect(isOwnerOrOrgManager(member, orgResource)).toBe(true);   // is the resource owner
    expect(isOwnerOrOrgManager(otherOrg, orgResource)).toBe(false);
  });

  it("does NOT let a plain org member manage another member's org resource", () => {
    const plain = { id: 9, isAdmin: false, membership: { organizationId: 7, role: "member" as const } };
    expect(isOwnerOrOrgManager(plain, orgResource)).toBe(false);
  });

  it("keeps admin out of isOwnerOrOrgManager but in canEditResource", () => {
    expect(isOwnerOrOrgManager(admin, orgResource)).toBe(false);
    expect(canEditResource(admin, orgResource)).toBe(true);
  });

  it("owner of a personal resource still qualifies", () => {
    expect(isOwnerOrOrgManager(member, personal)).toBe(true);
    expect(isOwnerOrOrgManager(owner, personal)).toBe(false);
  });

  it("hasOrg reflects membership", () => {
    expect(hasOrg(owner)).toBe(true);
    expect(hasOrg(outsider)).toBe(false);
  });
});
