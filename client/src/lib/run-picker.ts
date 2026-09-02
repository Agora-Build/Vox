/**
 * Pure helpers for the run dialog's two-level region/site agent picker.
 * Extracted from console-workflow-detail.tsx so the grouping/encoding logic
 * is unit-testable without a browser (see tests/run-picker.test.ts).
 */

export interface RunTargetAgent {
  tokenId: number;
  name: string;
  siteId: string | null;
  region: string | null;
  dispatchTier: string;
  locationTrust: string | null;
  price: number | null;
}

/** Informational-only public fleet row — never individually targetable, so
 * it carries no tokenId (the wire contract only accepts `{region,
 * targetTier:"public"}` for this tier, never a tokenId). */
export interface PublicFleetRow {
  siteId: string;
  region: string | null;
  state: string;
}

export interface RunTargetAgents {
  mine: RunTargetAgent[];
  shared: RunTargetAgent[];
  public: PublicFleetRow[];
}

/**
 * The run dialog's picker collapses to one selectable value: either a
 * region+tier pool ("run on any agent of this tier in this region") or a
 * specific site ("run on the agent occupying this site" — resolved to its
 * tokenId, since that's the only thing the wire contract accepts). Encoded
 * as a single string so it drops straight into a shadcn <Select>.
 */
export type PickerSelection =
  | { kind: "region"; region: string; targetTier: string }
  | { kind: "site"; tokenId: number };

export function encodePickerValue(sel: PickerSelection): string {
  return sel.kind === "region" ? `region:${sel.region}:${sel.targetTier}` : `site:${sel.tokenId}`;
}

export function decodePickerValue(value: string): PickerSelection | null {
  if (!value) return null;
  if (value.startsWith("region:")) {
    const rest = value.slice("region:".length);
    const sep = rest.lastIndexOf(":");
    if (sep < 0) return null;
    return { kind: "region", region: rest.slice(0, sep), targetTier: rest.slice(sep + 1) };
  }
  if (value.startsWith("site:")) {
    const tokenId = Number(value.slice("site:".length));
    return Number.isFinite(tokenId) ? { kind: "site", tokenId } : null;
  }
  return null;
}

export interface RegionGroup {
  region: string;
  label: string;
  private: RunTargetAgent[];
  team: RunTargetAgent[];
  shared: RunTargetAgent[];
  public: PublicFleetRow[];
}

/** A user's own shared-tier token can appear in both `mine` (as owner) and
 * `shared` (as a marketplace listing) with the same tokenId — drop the
 * marketplace copy so it renders once. */
export function dedupeSharedAgents(mine: RunTargetAgent[], shared: RunTargetAgent[]): RunTargetAgent[] {
  return shared.filter((s) => !mine.some((m) => m.tokenId === s.tokenId));
}

/**
 * Build the two-level region -> tier tree. Only regions with at least one
 * actual row (private/team/shared from `nonPublicAgents`, or an
 * informational public row) appear — no catalog-only fallback, so the tree
 * never offers a region the server has no dispatchable agent for.
 */
export function buildRegionGroups(
  nonPublicAgents: RunTargetAgent[],
  publicRows: PublicFleetRow[],
  labelFor: (region: string) => string,
): RegionGroup[] {
  const byRegion = new Map<string, RegionGroup>();
  const ensure = (region: string): RegionGroup => {
    let g = byRegion.get(region);
    if (!g) {
      g = { region, label: labelFor(region), private: [], team: [], shared: [], public: [] };
      byRegion.set(region, g);
    }
    return g;
  };
  for (const a of nonPublicAgents) {
    if (a.region == null) continue;
    const g = ensure(a.region);
    if (a.dispatchTier === "private") g.private.push(a);
    else if (a.dispatchTier === "team") g.team.push(a);
    else if (a.dispatchTier === "shared") g.shared.push(a);
  }
  for (const r of publicRows) {
    if (r.region == null) continue;
    ensure(r.region).public.push(r);
  }
  return Array.from(byRegion.values()).sort((a, b) => a.label.localeCompare(b.label));
}

/** Private/team agents with no detected site (siteId === null → Unverified).
 * Shared-tier Unverified rows never reach the client at all — filtered
 * server-side in run-targets — so they're excluded here by construction
 * (this only scans private/team). */
export function buildUnverifiedAgents(nonPublicAgents: RunTargetAgent[]): RunTargetAgent[] {
  return nonPublicAgents.filter(
    (a) => a.siteId === null && (a.dispatchTier === "private" || a.dispatchTier === "team")
  );
}

/** Public agents in this region currently not offline — used for the
 * per-region "(N online)" annotation on a region's public pool node, instead
 * of a global tier-wide count. */
export function countOnlinePublic(group: RegionGroup): number {
  return group.public.filter((r) => r.state !== "offline").length;
}
