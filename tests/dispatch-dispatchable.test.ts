import { describe, it, expect } from "vitest";
import { filterDispatchableAgents, type DispatchableAgentRow } from "../server/dispatch";

const user = { id: 1, organizationId: 10 };
const rows: DispatchableAgentRow[] = [
  { tokenId: 1, region: "r", dispatchTier: "public", ownerId: 2, ownerOrgId: 99, state: "idle" },
  { tokenId: 2, region: "r", dispatchTier: "private", ownerId: 1, ownerOrgId: 10, state: "idle" },
  { tokenId: 3, region: "r", dispatchTier: "private", ownerId: 2, ownerOrgId: 99, state: "idle" },
  { tokenId: 4, region: "r", dispatchTier: "team", ownerId: 2, ownerOrgId: 10, state: "idle" },
  { tokenId: 5, region: "r", dispatchTier: "team", ownerId: 3, ownerOrgId: 99, state: "idle" },
  { tokenId: 6, region: "r", dispatchTier: "shared", ownerId: 2, ownerOrgId: 99, state: "idle" },
];

describe("filterDispatchableAgents", () => {
  it("includes all public, own-private, and same-org team; excludes others' private, cross-org team, and shared", () => {
    const ids = filterDispatchableAgents(user, rows).map((r) => r.tokenId).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 4]);
  });
});
