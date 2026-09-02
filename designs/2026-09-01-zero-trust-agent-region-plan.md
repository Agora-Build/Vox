# Zero-Trust Agent Region Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Non-public eval agents get their region observed and verified by Vox (GeoIP + trust ladder on the observed IP) instead of user-asserted; Unverified agents keep working for their owner but never contribute region-attributed benchmark data.

**Architecture:** A new `server/location.ts` holds a pure trust ladder + hysteresis state machine and an impure shell (maxmind readers, Tor exit list, ASN classification). Registration/heartbeat run detection and assign `region`/`siteId` on the **agent** row; claim uses tier-dependent effective identity (public → token, else agent) and freezes `location_trust` onto the job. Metrics gain a community trust gate, an `unverified` scope, and a per-tab available-regions endpoint; the UI splits the region tree into fixed-mainline vs dynamic.

**Tech Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, `maxmind` (pure-JS mmdb reader), Vitest, Playwright.

**Spec:** `designs/2026-09-01-zero-trust-agent-region-design.md` — the binding authority for every requirement below. Read it first.

## Global Constraints

- **Zero trust:** no API path may accept a caller-supplied region for a non-public token/agent — reject, never silently ignore (spec "API surface changes").
- Trust values (varchar, enforced in code): `trusted | datacenter | anonymized | low_confidence | unknown`; region-eligible = `trusted | datacenter` only.
- Constants (exact values): city accuracy cutoff **100 km**; catalog nearest-match radius **100 km**; hysteresis stability **3** consecutive re-detections; staleness re-check **24 h**.
- **Distrust fast, trust slow:** trust drops apply immediately; region changes wait for hysteresis.
- Missing GeoIP DBs must degrade to `unknown` — local dev and CI have no MaxMind account; nothing may crash or block registration.
- `location_source` and raw IPs are Core-internal: never returned by any API. Only `region`, `siteId`, and the coarse `locationTrust` value are exposed.
- History is immutable: completed jobs/results keep their `site_id`; community metrics grandfather rows with `location_trust IS NULL`.
- Migration SQL is plain DDL/DML (no `IF NOT EXISTS` tricks) and MUST be registered in `server/migrate.ts` `MIGRATIONS` (project rule).
- Every commit message ends with: `🤖 Built with SMT <smt@agora.build>`
- Integration tests hit the RUNNING dev server on `localhost:5000`. **Server-code changes are invisible until `./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start`** — restart before running any `tests/*.test.ts` that exercises routes you changed. DB-level suites `describe.skip` without `DATABASE_URL`; run them as `DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run <file>` after `set -a; . ./.env; . ./.env.dev; set +a`.
- `npm run check` and `npm run lint` must pass before every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/schema.ts` (modify) | New columns + `LocationTrust` type + `REGION_ELIGIBLE_TRUST` |
| `migrations/0035_zero_trust_agent_region.sql` (create) | DDL + mainline/coords backfill + non-public region wipe |
| `server/migrate.ts` (modify) | Register version 36 |
| `server/location.ts` (create) | Trust ladder, hysteresis, baseId derivation (pure) + mmdb/Tor/ASN loaders, `detectLocation`, `runAgentLocationCheck` (shell) |
| `server/data/asn-classification.json` (create) | Curated ASN → `vpn`/`hosting` map |
| `server/storage.ts` (modify) | `allocateSiteId`, agent-location updates, nearest/detected catalog rows, tokens without location, claim identity + trust freeze, community gate, unverified scope, available regions |
| `server/marketplace.ts` (modify) | `region` nullable in `setListing` meta; new `updateListingRegion` |
| `server/routes.ts` (modify) | Mint gating, register/heartbeat wiring, agents listing fields, available-regions endpoint, `unverified` scope parsing |
| `client/src/lib/utils.ts` (modify) | `RegionLocation.isMainline`, unverified-aware scope helpers |
| `client/src/components/region-scope-selector.tsx` (modify) | `showUnverified` node |
| `client/src/pages/realtime.tsx` (modify) | Per-tab visible locations + availability query |
| `client/src/pages/console-eval-agents.tsx` (modify) | Tier-gated region picker, trust badges, "auto" siteId |
| `client/src/pages/admin-regions.tsx` (modify) | `isMainline` toggle, source/coords display |
| `scripts/geoip-refresh.sh` (create) | Download GeoLite2 mmdbs |
| `tests/location.test.ts` (create) | Pure-core unit tests |
| `tests/location-catalog.test.ts` (create) | DB: nearest/auto-create, allocateSiteId, applyAgentLocation |
| `tests/zero-trust-region-api.test.ts` (create) | HTTP: mint gating, register/heartbeat unknown-path, agents listing |
| `tests/zero-trust-dispatch.test.ts` (create) | DB: claim gating + trust freeze |
| `tests/zero-trust-metrics.test.ts` (create) | DB: community gate, unverified scope, available regions |
| `tests/e2e/agent-region.spec.ts` (create) | Mint dialog tier-gating |
| `CLAUDE.md` (modify) | New env vars + geoip-refresh note |

---

### Task 1: Schema + migration 0035

**Files:**
- Modify: `shared/schema.ts` (regionLocations ~104, evalAgentTokens ~205, evalAgents ~233, evalJobs ~356, evalResults ~412)
- Create: `migrations/0035_zero_trust_agent_region.sql`
- Modify: `server/migrate.ts` (MIGRATIONS array, after version 35)

**Interfaces:**
- Produces: `LocationTrust` type, `locationTrustValues`, `REGION_ELIGIBLE_TRUST` (exported from `shared/schema.ts`); nullable `evalAgentTokens.siteId/region`; `evalAgents.region/locationTrust/locationCheckedAt/locationSource/pendingRegion/pendingRegionCount` + nullable `siteId`; `evalJobs.locationTrust`; nullable `evalResults.siteId`; `regionLocations.latitude/longitude/source/isMainline`.

- [ ] **Step 1: Edit `shared/schema.ts`**

Add near the top (after the existing enum definitions):

```ts
// Location trust — varchar column, values enforced in code (spec: trust model).
export const locationTrustValues = ["trusted", "datacenter", "anonymized", "low_confidence", "unknown"] as const;
export type LocationTrust = (typeof locationTrustValues)[number];
// Only these may hold a region/siteId and contribute region-attributed data.
export const REGION_ELIGIBLE_TRUST: readonly LocationTrust[] = ["trusted", "datacenter"];
```

Add `doublePrecision` to the `drizzle-orm/pg-core` import. In `regionLocations`, after `isActive`:

```ts
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  // 'configured' = admin-created; 'detected' = auto-created from agent observation.
  source: varchar("source", { length: 16 }).default("configured").notNull(),
  isMainline: boolean("is_mainline").default(false).notNull(),
```

In `evalAgentTokens`: drop `.notNull()` from `siteId` and `region` (keep the existing comment; region/siteId are now stamped at mint for public-tier tokens only).

In `evalAgents`: drop `.notNull()` from `siteId`; after `observedIpAt` add:

```ts
  // Zero-trust location (non-public agents): Vox-detected region baseId; NULL =
  // Unverified. siteId above is allocated from this region at assignment time.
  region: varchar("region", { length: 64 }),
  locationTrust: varchar("location_trust", { length: 16 }).default("unknown").notNull(),
  locationCheckedAt: timestamp("location_checked_at"),
  // Full detection evidence (city/coords/asn/signals). Core-internal — never
  // exposed on any API, same rule as observedIp.
  locationSource: jsonb("location_source"),
  // Hysteresis: a region CHANGE applies only after the same new observation on
  // 3 consecutive re-detections. Trust drops apply immediately (no pending).
  pendingRegion: varchar("pending_region", { length: 64 }),
  pendingRegionCount: integer("pending_region_count").default(0).notNull(),
```

In `evalJobs`, after `tokenDispatchTier` (or nearby frozen-at-claim fields): 

```ts
  // Frozen at claim alongside token_dispatch_tier: the claiming agent's
  // location trust ('trusted' for public/configured agents). NULL = pre-feature
  // row (grandfathered by the community gate).
  locationTrust: varchar("location_trust", { length: 16 }),
```

In `evalResults`: drop `.notNull()` from `siteId` (NULL = ran without a verified region → the My Evals "Unverified" bucket).

- [ ] **Step 2: Write `migrations/0035_zero_trust_agent_region.sql`**

```sql
ALTER TABLE "region_locations" ADD COLUMN "latitude" double precision;
--> statement-breakpoint
ALTER TABLE "region_locations" ADD COLUMN "longitude" double precision;
--> statement-breakpoint
ALTER TABLE "region_locations" ADD COLUMN "source" varchar(16) NOT NULL DEFAULT 'configured';
--> statement-breakpoint
ALTER TABLE "region_locations" ADD COLUMN "is_mainline" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "region_locations" SET "is_mainline" = true, "latitude" = 47.6062,  "longitude" = -122.3321 WHERE "base_id" = 'na-us-seattle';
--> statement-breakpoint
UPDATE "region_locations" SET "is_mainline" = true, "latitude" = 1.3521,   "longitude" = 103.8198  WHERE "base_id" = 'apac-sg';
--> statement-breakpoint
UPDATE "region_locations" SET "is_mainline" = true, "latitude" = 19.0760,  "longitude" = 72.8777   WHERE "base_id" = 'apac-in-mumbai';
--> statement-breakpoint
UPDATE "region_locations" SET "is_mainline" = true, "latitude" = 50.1109,  "longitude" = 8.6821    WHERE "base_id" = 'eu-de-frankfurt';
--> statement-breakpoint
UPDATE "region_locations" SET "is_mainline" = true, "latitude" = -23.5505, "longitude" = -46.6333  WHERE "base_id" = 'sa-br-saopaulo';
--> statement-breakpoint
ALTER TABLE "eval_agent_tokens" ALTER COLUMN "site_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_agent_tokens" ALTER COLUMN "region" DROP NOT NULL;
--> statement-breakpoint
UPDATE "eval_agent_tokens" SET "site_id" = NULL, "region" = NULL WHERE "dispatch_tier" <> 'public';
--> statement-breakpoint
ALTER TABLE "eval_agents" ALTER COLUMN "site_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "region" varchar(64);
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "location_trust" varchar(16) NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "location_checked_at" timestamp;
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "location_source" jsonb;
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "pending_region" varchar(64);
--> statement-breakpoint
ALTER TABLE "eval_agents" ADD COLUMN "pending_region_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE "eval_agents" SET "site_id" = NULL
  WHERE "token_id" IN (SELECT "id" FROM "eval_agent_tokens" WHERE "dispatch_tier" <> 'public');
--> statement-breakpoint
ALTER TABLE "eval_jobs" ADD COLUMN "location_trust" varchar(16);
--> statement-breakpoint
ALTER TABLE "eval_results" ALTER COLUMN "site_id" DROP NOT NULL;
```

- [ ] **Step 3: Register in `server/migrate.ts`**

Append to `MIGRATIONS`:

```ts
  { version: 36, description: "zero-trust agent region: agent-side detected location, nullable token/agent/result site_id, job location_trust, catalog coords/source/is_mainline", file: "0035_zero_trust_agent_region.sql" },
```

- [ ] **Step 4: Apply to the dev DB and verify**

```bash
docker exec -i vox-postgres psql -U vox -d vox -v ON_ERROR_STOP=1 < migrations/0035_zero_trust_agent_region.sql
docker exec vox-postgres psql -U vox -d vox -c "UPDATE _schema_version SET version = 36"
docker exec vox-postgres psql -U vox -d vox -c "\d eval_agents" | grep -E "region|location|pending"
docker exec vox-postgres psql -U vox -d vox -c "SELECT base_id, is_mainline, latitude FROM region_locations ORDER BY base_id"
```

Expected: the 6 new eval_agents columns exist; five seeded rows show `is_mainline = t` with coordinates.

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: PASS (nothing consumes the new columns yet; nullable siteId may surface type errors in `server/storage.ts`/`server/routes.ts` — if so, fix ONLY with local null-guards that preserve today's behavior, e.g. `token.siteId!` is forbidden; prefer explicit `?? null` plumbing, and leave semantic changes to Tasks 5–7).

- [ ] **Step 6: Commit**

```bash
git add shared/schema.ts migrations/0035_zero_trust_agent_region.sql server/migrate.ts
git commit -m "feat(schema): zero-trust agent region columns + migration 0035

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 2: `server/location.ts` pure core — trust ladder + hysteresis

**Files:**
- Create: `server/location.ts`
- Test: `tests/location.test.ts`

**Interfaces:**
- Consumes: `LocationTrust`, `REGION_ELIGIBLE_TRUST` from `@shared/schema` (Task 1).
- Produces (exact exports later tasks rely on):

```ts
export interface GeoLookup {
  city?: string; countryCode?: string; countryName?: string; continentCode?: string;
  lat?: number; lon?: number; accuracyKm?: number;
}
export interface AsnLookup { asn?: number; org?: string }
export interface LocationSignals {
  geo: GeoLookup | null;
  asn: AsnLookup | null;
  isTorExit: boolean;
  asnClass: "vpn" | "hosting" | null;
}
export interface RegionCandidate {
  baseId: string; displayName: string; city: string;
  countryCode: string; countryName: string;
  macroRegionCode: string; macroRegionName: string;
  latitude: number; longitude: number;
}
export interface Detection {
  trust: LocationTrust;
  candidate: RegionCandidate | null; // non-null iff trust is region-eligible
  source: {
    city: string | null; countryCode: string | null;
    lat: number | null; lon: number | null; accuracyKm: number | null;
    asn: number | null; asnOrg: string | null; signals: string[];
  };
}
export interface LocationNextState {
  region: string | null;      // next region baseId (null = Unverified)
  changed: boolean;           // true → caller must (re)allocate or clear siteId
  pendingRegion: string | null;
  pendingRegionCount: number;
}
export const MAX_CITY_ACCURACY_KM = 100;
export const CATALOG_MATCH_KM = 100;
export const REGION_CHANGE_STABILITY = 3;
export const LOCATION_RECHECK_HOURS = 24;
export function isPublicIp(ip: string): boolean;
export function classifyLocation(ip: string, signals: LocationSignals): Detection;
export function slugCity(city: string): string;
export function macroForContinent(continentCode: string): { code: string; name: string } | null;
export function deriveRegionCandidate(geo: GeoLookup): RegionCandidate | null;
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number;
export function decideLocationTransition(
  agent: { region: string | null; pendingRegion: string | null; pendingRegionCount: number },
  det: { trust: LocationTrust; baseId: string | null },
  opts: { immediate: boolean },
): LocationNextState;
```

- [ ] **Step 1: Write failing unit tests**

Create `tests/location.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  isPublicIp, classifyLocation, slugCity, macroForContinent, deriveRegionCandidate,
  haversineKm, decideLocationTransition, REGION_CHANGE_STABILITY,
  type LocationSignals, type GeoLookup,
} from "../server/location";

const geoMumbai: GeoLookup = {
  city: "Mumbai", countryCode: "IN", countryName: "India", continentCode: "AS",
  lat: 19.076, lon: 72.877, accuracyKm: 20,
};
const signals = (over: Partial<LocationSignals> = {}): LocationSignals => ({
  geo: geoMumbai, asn: { asn: 55836, org: "Reliance Jio" }, isTorExit: false, asnClass: null, ...over,
});

describe("isPublicIp", () => {
  it.each([
    ["10.1.2.3", false], ["172.16.0.1", false], ["192.168.5.140", false],
    ["127.0.0.1", false], ["169.254.1.1", false], ["100.64.0.1", false],
    ["::1", false], ["fc00::1", false], ["fe80::1", false],
    ["8.8.8.8", true], ["49.36.100.1", true], ["2001:4860:4860::8888", true],
    ["not-an-ip", false], ["", false],
  ])("%s → %s", (ip, expected) => expect(isPublicIp(ip)).toBe(expected));
});

describe("classifyLocation trust ladder (first match wins)", () => {
  it("private IP → unknown, no candidate", () => {
    const d = classifyLocation("192.168.1.1", signals());
    expect(d.trust).toBe("unknown");
    expect(d.candidate).toBeNull();
  });
  it("Tor exit → anonymized even with clean geo", () => {
    expect(classifyLocation("49.36.100.1", signals({ isTorExit: true })).trust).toBe("anonymized");
  });
  it("vpn ASN → anonymized", () => {
    expect(classifyLocation("49.36.100.1", signals({ asnClass: "vpn" })).trust).toBe("anonymized");
  });
  it("geo miss → low_confidence", () => {
    expect(classifyLocation("49.36.100.1", signals({ geo: null })).trust).toBe("low_confidence");
  });
  it("no city → low_confidence", () => {
    expect(classifyLocation("49.36.100.1", signals({ geo: { ...geoMumbai, city: undefined } })).trust).toBe("low_confidence");
  });
  it("accuracy radius > 100km → low_confidence", () => {
    expect(classifyLocation("49.36.100.1", signals({ geo: { ...geoMumbai, accuracyKm: 500 } })).trust).toBe("low_confidence");
  });
  it("hosting ASN → datacenter WITH a candidate (location trusted)", () => {
    const d = classifyLocation("3.6.100.1", signals({ asnClass: "hosting" }));
    expect(d.trust).toBe("datacenter");
    expect(d.candidate?.baseId).toBe("apac-in-mumbai");
  });
  it("clean residential → trusted with candidate", () => {
    const d = classifyLocation("49.36.100.1", signals());
    expect(d.trust).toBe("trusted");
    expect(d.candidate).toMatchObject({ baseId: "apac-in-mumbai", macroRegionCode: "apac", countryCode: "IN" });
  });
  it("anonymized/low_confidence/unknown never carry a candidate", () => {
    for (const d of [
      classifyLocation("49.36.100.1", signals({ isTorExit: true })),
      classifyLocation("49.36.100.1", signals({ geo: null })),
      classifyLocation("10.0.0.1", signals()),
    ]) expect(d.candidate).toBeNull();
  });
  it("source never contains the raw signals objects, only scalars + signal names", () => {
    const d = classifyLocation("49.36.100.1", signals());
    expect(d.source).toEqual({
      city: "Mumbai", countryCode: "IN", lat: 19.076, lon: 72.877,
      accuracyKm: 20, asn: 55836, asnOrg: "Reliance Jio", signals: [],
    });
  });
});

describe("baseId derivation", () => {
  it("slugCity lowercases, folds accents, strips non-alphanumerics", () => {
    expect(slugCity("Santa Clara")).toBe("santaclara");
    expect(slugCity("São Paulo")).toBe("saopaulo");
    expect(slugCity("Frankfurt am Main")).toBe("frankfurtammain");
  });
  it("macroForContinent maps per spec", () => {
    expect(macroForContinent("NA")).toEqual({ code: "na", name: "North America" });
    expect(macroForContinent("SA")).toEqual({ code: "sa", name: "South America" });
    expect(macroForContinent("EU")).toEqual({ code: "eu", name: "Europe" });
    expect(macroForContinent("AS")).toEqual({ code: "apac", name: "Asia Pacific" });
    expect(macroForContinent("OC")).toEqual({ code: "apac", name: "Asia Pacific" });
    expect(macroForContinent("AF")).toEqual({ code: "af", name: "Africa" });
    expect(macroForContinent("AN")).toBeNull();
  });
  it("deriveRegionCandidate builds <macro>-<cc>-<cityslug>", () => {
    expect(deriveRegionCandidate({
      city: "Santa Clara", countryCode: "US", countryName: "United States",
      continentCode: "NA", lat: 37.35, lon: -121.95, accuracyKm: 10,
    })).toMatchObject({ baseId: "na-us-santaclara", displayName: "Santa Clara", macroRegionCode: "na" });
  });
  it("deriveRegionCandidate → null for Antarctica or missing fields", () => {
    expect(deriveRegionCandidate({ ...geoMumbai, continentCode: "AN" })).toBeNull();
    expect(deriveRegionCandidate({ ...geoMumbai, lat: undefined })).toBeNull();
  });
});

describe("haversineKm", () => {
  it("Seattle→Frankfurt ≈ 8ooo+ km; Sunnyvale→Santa Clara < 15 km", () => {
    expect(haversineKm(47.6062, -122.3321, 50.1109, 8.6821)).toBeGreaterThan(8000);
    expect(haversineKm(37.3688, -122.0363, 37.3541, -121.9552)).toBeLessThan(15);
  });
});

describe("decideLocationTransition", () => {
  const fresh = { region: null, pendingRegion: null, pendingRegionCount: 0 };
  const inMumbai = { region: "apac-in-mumbai", pendingRegion: null, pendingRegionCount: 0 };

  it("eligible + immediate (registration) assigns at once", () => {
    expect(decideLocationTransition(fresh, { trust: "trusted", baseId: "apac-in-mumbai" }, { immediate: true }))
      .toEqual({ region: "apac-in-mumbai", changed: true, pendingRegion: null, pendingRegionCount: 0 });
  });
  it("same region observed again → keep, pending cleared", () => {
    expect(decideLocationTransition(
      { ...inMumbai, pendingRegion: "eu-de-frankfurt", pendingRegionCount: 2 },
      { trust: "trusted", baseId: "apac-in-mumbai" }, { immediate: false },
    )).toEqual({ region: "apac-in-mumbai", changed: false, pendingRegion: null, pendingRegionCount: 0 });
  });
  it("region change on heartbeat: pends 1, 2, applies at 3", () => {
    const det = { trust: "trusted" as const, baseId: "eu-de-frankfurt" };
    const s1 = decideLocationTransition(inMumbai, det, { immediate: false });
    expect(s1).toEqual({ region: "apac-in-mumbai", changed: false, pendingRegion: "eu-de-frankfurt", pendingRegionCount: 1 });
    const s2 = decideLocationTransition({ ...inMumbai, pendingRegion: s1.pendingRegion, pendingRegionCount: s1.pendingRegionCount }, det, { immediate: false });
    expect(s2.pendingRegionCount).toBe(2);
    expect(s2.changed).toBe(false);
    const s3 = decideLocationTransition({ ...inMumbai, pendingRegion: s2.pendingRegion, pendingRegionCount: s2.pendingRegionCount }, det, { immediate: false });
    expect(s3).toEqual({ region: "eu-de-frankfurt", changed: true, pendingRegion: null, pendingRegionCount: 0 });
    expect(REGION_CHANGE_STABILITY).toBe(3);
  });
  it("a differing observation resets the pending counter", () => {
    const s = decideLocationTransition(
      { ...inMumbai, pendingRegion: "eu-de-frankfurt", pendingRegionCount: 2 },
      { trust: "trusted", baseId: "na-us-seattle" }, { immediate: false },
    );
    expect(s).toEqual({ region: "apac-in-mumbai", changed: false, pendingRegion: "na-us-seattle", pendingRegionCount: 1 });
  });
  it("trust drop clears region IMMEDIATELY, even mid-pending", () => {
    expect(decideLocationTransition(
      { ...inMumbai, pendingRegion: "eu-de-frankfurt", pendingRegionCount: 2 },
      { trust: "anonymized", baseId: null }, { immediate: false },
    )).toEqual({ region: null, changed: true, pendingRegion: null, pendingRegionCount: 0 });
  });
  it("still-Unverified stays put without churn", () => {
    expect(decideLocationTransition(fresh, { trust: "unknown", baseId: null }, { immediate: false }))
      .toEqual({ region: null, changed: false, pendingRegion: null, pendingRegionCount: 0 });
  });
  it("upgrade from Unverified on heartbeat also uses hysteresis", () => {
    const s = decideLocationTransition(fresh, { trust: "trusted", baseId: "apac-in-mumbai" }, { immediate: false });
    expect(s).toEqual({ region: null, changed: false, pendingRegion: "apac-in-mumbai", pendingRegionCount: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/location.test.ts`
Expected: FAIL — cannot resolve `../server/location`.

- [ ] **Step 3: Implement the pure core in `server/location.ts`**

```ts
import { REGION_ELIGIBLE_TRUST, type LocationTrust } from "@shared/schema";

// (paste the interface/const exports from the Interfaces block above verbatim)

const PRIVATE_V4: Array<[number, number]> = [
  // [network as u32, prefix length] — RFC1918 + loopback + link-local + CGNAT
  [0x0a000000, 8],    // 10/8
  [0xac100000, 12],   // 172.16/12
  [0xc0a80000, 16],   // 192.168/16
  [0x7f000000, 8],    // 127/8
  [0xa9fe0000, 16],   // 169.254/16
  [0x64400000, 10],   // 100.64/10 (CGNAT)
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

export function isPublicIp(ip: string): boolean {
  if (!ip) return false;
  const bare = ip.startsWith("::ffff:") ? ip.slice(7) : ip; // v4-mapped v6
  const v4 = v4ToInt(bare);
  if (v4 !== null) {
    return !PRIVATE_V4.some(([net, bits]) => (v4 >>> (32 - bits)) === (net >>> (32 - bits)));
  }
  if (!bare.includes(":")) return false; // neither valid v4 nor v6
  const lower = bare.toLowerCase();
  if (lower === "::1" || lower === "::") return false;
  // fc00::/7 (unique local), fe80::/10 (link-local)
  if (/^f[cd]/.test(lower) || lower.startsWith("fe8") || lower.startsWith("fe9")
    || lower.startsWith("fea") || lower.startsWith("feb")) return false;
  return true;
}

export function slugCity(city: string): string {
  return city.normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MACROS: Record<string, { code: string; name: string }> = {
  NA: { code: "na", name: "North America" },
  SA: { code: "sa", name: "South America" },
  EU: { code: "eu", name: "Europe" },
  AS: { code: "apac", name: "Asia Pacific" },
  OC: { code: "apac", name: "Asia Pacific" },
  AF: { code: "af", name: "Africa" },
};

export function macroForContinent(continentCode: string): { code: string; name: string } | null {
  return MACROS[continentCode] ?? null;
}

export function deriveRegionCandidate(geo: GeoLookup): RegionCandidate | null {
  if (!geo.city || !geo.countryCode || !geo.continentCode
    || geo.lat === undefined || geo.lon === undefined) return null;
  const macro = macroForContinent(geo.continentCode);
  if (!macro) return null;
  const slug = slugCity(geo.city);
  if (!slug) return null;
  return {
    baseId: `${macro.code}-${geo.countryCode.toLowerCase()}-${slug}`,
    displayName: geo.city,
    city: geo.city,
    countryCode: geo.countryCode.toUpperCase(),
    countryName: geo.countryName ?? geo.countryCode.toUpperCase(),
    macroRegionCode: macro.code,
    macroRegionName: macro.name,
    latitude: geo.lat,
    longitude: geo.lon,
  };
}

// haversineKm lives in shared/regions.ts (dependency-free) because
// server/storage.ts also needs it and storage must NOT import from
// ./location (location imports storage — cycle). Re-export it here:
//
//   // shared/regions.ts — append:
//   export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
//     const rad = (d: number) => (d * Math.PI) / 180;
//     const dLat = rad(lat2 - lat1);
//     const dLon = rad(lon2 - lon1);
//     const a = Math.sin(dLat / 2) ** 2
//       + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
//     return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
//   }
//
//   // server/location.ts:
export { haversineKm } from "@shared/regions";

export function classifyLocation(ip: string, signals: LocationSignals): Detection {
  const source = {
    city: signals.geo?.city ?? null,
    countryCode: signals.geo?.countryCode ?? null,
    lat: signals.geo?.lat ?? null,
    lon: signals.geo?.lon ?? null,
    accuracyKm: signals.geo?.accuracyKm ?? null,
    asn: signals.asn?.asn ?? null,
    asnOrg: signals.asn?.org ?? null,
    signals: [
      ...(signals.isTorExit ? ["tor-exit"] : []),
      ...(signals.asnClass ? [`asn:${signals.asnClass}`] : []),
    ],
  };
  const done = (trust: LocationTrust, candidate: RegionCandidate | null = null): Detection =>
    ({ trust, candidate, source });

  // Ladder — first match wins (spec: detection pipeline).
  if (!isPublicIp(ip)) return done("unknown");
  if (signals.isTorExit || signals.asnClass === "vpn") return done("anonymized");
  if (!signals.geo || !signals.geo.city
    || (signals.geo.accuracyKm !== undefined && signals.geo.accuracyKm > MAX_CITY_ACCURACY_KM)) {
    return done("low_confidence");
  }
  const candidate = deriveRegionCandidate(signals.geo);
  if (!candidate) return done("low_confidence");
  if (signals.asnClass === "hosting") return done("datacenter", candidate);
  return done("trusted", candidate);
}

export function decideLocationTransition(
  agent: { region: string | null; pendingRegion: string | null; pendingRegionCount: number },
  det: { trust: LocationTrust; baseId: string | null },
  opts: { immediate: boolean },
): LocationNextState {
  const eligible = REGION_ELIGIBLE_TRUST.includes(det.trust) && det.baseId !== null;
  if (!eligible) {
    // Distrust fast: clear at once; pending state is meaningless now.
    return { region: null, changed: agent.region !== null, pendingRegion: null, pendingRegionCount: 0 };
  }
  if (det.baseId === agent.region) {
    return { region: agent.region, changed: false, pendingRegion: null, pendingRegionCount: 0 };
  }
  if (opts.immediate) {
    // Registration is a fresh process — apply without hysteresis (spec).
    return { region: det.baseId, changed: true, pendingRegion: null, pendingRegionCount: 0 };
  }
  const count = det.baseId === agent.pendingRegion ? agent.pendingRegionCount + 1 : 1;
  if (count >= REGION_CHANGE_STABILITY) {
    return { region: det.baseId, changed: true, pendingRegion: null, pendingRegionCount: 0 };
  }
  return { region: agent.region, changed: false, pendingRegion: det.baseId, pendingRegionCount: count };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/location.test.ts`
Expected: PASS. Also run `npm run check` and `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add server/location.ts tests/location.test.ts
git commit -m "feat(location): trust ladder, baseId derivation, hysteresis state machine

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 3: Detection shell — mmdb/Tor/ASN loaders + catalog resolution

**Files:**
- Modify: `server/location.ts` (append shell section)
- Create: `server/data/asn-classification.json`
- Modify: `server/storage.ts` (catalog methods), `package.json` (add `maxmind`), `.gitignore` (add `geoip/`)
- Test: `tests/location.test.ts` (detectLocation with injected deps), `tests/location-catalog.test.ts` (DB)

**Interfaces:**
- Consumes: Task 2 exports; `storage` singleton.
- Produces:

```ts
// server/location.ts
export interface DetectionDeps {
  geo: (ip: string) => GeoLookup | null;
  asn: (ip: string) => AsnLookup | null;
  torExits: ReadonlySet<string>;
  asnClass: Readonly<Record<string, "vpn" | "hosting">>;
}
export function detectLocation(ip: string, deps?: DetectionDeps): Detection; // deps default = live loaders
export async function resolveCatalogRegion(candidate: RegionCandidate): Promise<string>; // baseId
export function startLocationServices(): void; // called once from server/index.ts: load mmdbs, schedule Tor refresh

// server/storage.ts (DatabaseStorage methods)
findNearestActiveRegion(lat: number, lon: number, maxKm: number): Promise<RegionLocation | undefined>;
createDetectedRegionLocation(candidate: RegionCandidate): Promise<RegionLocation>;
```

- [ ] **Step 1: Install maxmind + gitignore the DB dir**

```bash
npm install maxmind
echo "geoip/" >> .gitignore
```

- [ ] **Step 2: Create `server/data/asn-classification.json`**

Curated starter set (refreshed/extended by hand; see the header key). Format: ASN → class.

```json
{
  "_comment": "ASN -> vpn|hosting. Curated from public lists (X4BNet lists_vpn, ipcat). 'hosting' = location-trusted datacenter; 'vpn' = anonymizer, never region-attributed.",
  "16509": "hosting", "14618": "hosting", "15169": "hosting", "396982": "hosting",
  "8075": "hosting", "14061": "hosting", "24940": "hosting", "16276": "hosting",
  "63949": "hosting", "20473": "hosting", "13335": "hosting", "54825": "hosting",
  "9009": "vpn", "60068": "vpn", "212238": "vpn", "206092": "vpn",
  "207137": "vpn", "62240": "vpn", "136787": "vpn"
}
```

- [ ] **Step 3: Write failing tests**

Append to `tests/location.test.ts`:

```ts
import { detectLocation, type DetectionDeps } from "../server/location";

describe("detectLocation with injected deps", () => {
  const deps: DetectionDeps = {
    geo: (ip) => ip === "49.36.100.1" ? geoMumbai : null,
    asn: (ip) => ip === "49.36.100.1" ? { asn: 55836, org: "Jio" } : { asn: 9009, org: "M247" },
    torExits: new Set(["185.220.101.1"]),
    asnClass: { "9009": "vpn", "16509": "hosting" },
  };
  it("resolves geo+asn through deps", () => {
    const d = detectLocation("49.36.100.1", deps);
    expect(d.trust).toBe("trusted");
    expect(d.candidate?.baseId).toBe("apac-in-mumbai");
  });
  it("Tor exit set is consulted", () => {
    expect(detectLocation("185.220.101.1", deps).trust).toBe("anonymized");
  });
  it("vpn ASN via classification map", () => {
    expect(detectLocation("1.2.3.4", deps).trust).toBe("anonymized"); // asn 9009 → vpn
  });
  it("no deps and no mmdbs on disk → graceful unknown/low_confidence, never throws", () => {
    const d = detectLocation("8.8.8.8"); // live loaders; CI/dev has no geoip/ dir
    expect(["low_confidence", "unknown"]).toContain(d.trust);
  });
});
```

Create `tests/location-catalog.test.ts` (DB-level — guard like other DB suites):

```ts
import { describe, it, expect, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import { storage, db } from "../server/storage";
import { regionLocations } from "../shared/schema";
import { resolveCatalogRegion } from "../server/location";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("catalog resolution", () => {
  afterAll(async () => {
    await db.delete(regionLocations).where(like(regionLocations.baseId, "zz-%"));
  });

  it("findNearestActiveRegion matches within 100km (Sunnyvale → Santa Clara/Seattle rule)", async () => {
    // Seeded Seattle row has coords from migration 0035.
    const near = await storage.findNearestActiveRegion(47.61, -122.20, 100); // ~10km east of Seattle
    expect(near?.baseId).toBe("na-us-seattle");
    const far = await storage.findNearestActiveRegion(64.14, -21.94, 100); // Reykjavik
    expect(far).toBeUndefined();
  });

  it("resolveCatalogRegion reuses a near row; auto-creates source='detected' otherwise", async () => {
    const nearSeattle = await resolveCatalogRegion({
      baseId: "na-us-bellevue", displayName: "Bellevue", city: "Bellevue",
      countryCode: "US", countryName: "United States",
      macroRegionCode: "na", macroRegionName: "North America",
      latitude: 47.61, longitude: -122.20,
    });
    expect(nearSeattle).toBe("na-us-seattle");

    const created = await resolveCatalogRegion({
      baseId: "zz-is-reykjavik", displayName: "Reykjavik", city: "Reykjavik",
      countryCode: "IS", countryName: "Iceland",
      macroRegionCode: "eu", macroRegionName: "Europe",
      latitude: 64.14, longitude: -21.94,
    });
    expect(created).toBe("zz-is-reykjavik");
    const row = await storage.getRegionLocationByBaseId("zz-is-reykjavik");
    expect(row?.source).toBe("detected");
    expect(row?.isMainline).toBe(false);
    // Idempotent on second call (unique base_id, 23505 → re-select).
    expect(await resolveCatalogRegion({
      baseId: "zz-is-reykjavik", displayName: "Reykjavik", city: "Reykjavik",
      countryCode: "IS", countryName: "Iceland",
      macroRegionCode: "eu", macroRegionName: "Europe",
      latitude: 64.14, longitude: -21.94,
    })).toBe("zz-is-reykjavik");
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `set -a; . ./.env; . ./.env.dev; set +a; DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/location.test.ts tests/location-catalog.test.ts`
Expected: FAIL — `detectLocation` / `findNearestActiveRegion` not defined.

- [ ] **Step 5: Implement**

Storage methods (in `DatabaseStorage`, near the other regionLocations methods ~line 439):

```ts
  async findNearestActiveRegion(lat: number, lon: number, maxKm: number): Promise<RegionLocation | undefined> {
    // Catalog is small (tens of rows) — fetch and haversine in JS.
    const rows = await db.select().from(regionLocations)
      .where(eq(regionLocations.isActive, true));
    let best: { row: RegionLocation; km: number } | undefined;
    for (const row of rows) {
      if (row.latitude == null || row.longitude == null) continue;
      const km = haversineKm(lat, lon, row.latitude, row.longitude);
      if (km <= maxKm && (!best || km < best.km)) best = { row, km };
    }
    return best?.row;
  }

  async createDetectedRegionLocation(candidate: RegionCandidate): Promise<RegionLocation> {
    try {
      const result = await db.insert(regionLocations).values({
        baseId: candidate.baseId,
        displayName: candidate.displayName,
        city: candidate.city,
        countryCode: candidate.countryCode,
        countryName: candidate.countryName,
        macroRegionCode: candidate.macroRegionCode,
        macroRegionName: candidate.macroRegionName,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        source: "detected",
        isMainline: false,
        isActive: true,
      }).returning();
      return result[0];
    } catch (err) {
      // Unique base_id race: another agent created it first — reuse.
      const existing = await this.getRegionLocationByBaseId(candidate.baseId);
      if (existing) return existing;
      throw err;
    }
  }
```

(Import `haversineKm` and `RegionCandidate` from `./location` in storage.ts — or, to avoid a storage→location import cycle since location.ts imports storage, move `haversineKm` INTO storage.ts and re-export from location.ts. **Cycle rule:** `server/location.ts` imports `storage`; `server/storage.ts` must NOT import from `./location`. Place `haversineKm` in `shared/regions.ts` (dependency-free) and import it from both.)

Shell section appended to `server/location.ts`:

```ts
import { open as maxmindOpen, type Reader, type CityResponse, type AsnResponse } from "maxmind";
import { readFileSync } from "fs";
import path from "path";
import { storage } from "./storage";

const GEOIP_DIR = process.env.GEOIP_DB_DIR || path.join(process.cwd(), "geoip");
let cityReader: Reader<CityResponse> | null = null;
let asnReader: Reader<AsnResponse> | null = null;
let torExits: Set<string> = new Set();
let asnClassification: Record<string, "vpn" | "hosting"> = {};
let warnedPrivateIp = false;

export function startLocationServices(): void {
  void (async () => {
    try { cityReader = await maxmindOpen<CityResponse>(path.join(GEOIP_DIR, "GeoLite2-City.mmdb")); }
    catch { console.log("[location] GeoLite2-City.mmdb not found — geolocation disabled (all agents Unverified)"); }
    try { asnReader = await maxmindOpen<AsnResponse>(path.join(GEOIP_DIR, "GeoLite2-ASN.mmdb")); }
    catch { console.log("[location] GeoLite2-ASN.mmdb not found — ASN signals disabled"); }
  })();
  try {
    asnClassification = JSON.parse(readFileSync(path.join(process.cwd(), "server/data/asn-classification.json"), "utf8"));
    delete (asnClassification as Record<string, unknown>)._comment;
  } catch { console.log("[location] asn-classification.json not readable — ASN class signals disabled"); }
  const refreshTor = async () => {
    try {
      const res = await fetch("https://check.torproject.org/torbulkexitlist");
      if (res.ok) torExits = new Set((await res.text()).split("\n").map(l => l.trim()).filter(Boolean));
    } catch { /* keep previous list */ }
  };
  void refreshTor();
  setInterval(refreshTor, 12 * 60 * 60 * 1000).unref();
}

function liveDeps(): DetectionDeps {
  return {
    geo: (ip) => {
      const hit = cityReader?.get(ip);
      if (!hit) return null;
      return {
        city: hit.city?.names?.en,
        countryCode: hit.country?.iso_code,
        countryName: hit.country?.names?.en,
        continentCode: hit.continent?.code,
        lat: hit.location?.latitude,
        lon: hit.location?.longitude,
        accuracyKm: hit.location?.accuracy_radius,
      };
    },
    asn: (ip) => {
      const hit = asnReader?.get(ip);
      return hit ? { asn: hit.autonomous_system_number, org: hit.autonomous_system_organization } : null;
    },
    torExits,
    asnClass: asnClassification,
  };
}

export function detectLocation(ip: string, deps: DetectionDeps = liveDeps()): Detection {
  if (!isPublicIp(ip)) {
    // Deployment tripwire (spec): a private IP in production means the proxy
    // hop count is likely wrong — every agent would geolocate to nothing.
    if (process.env.NODE_ENV === "production" && !warnedPrivateIp) {
      warnedPrivateIp = true;
      console.warn(`[location] observed a private client IP (${ip}) in production — trust-proxy hop count likely misconfigured; agents will stay Unverified`);
    }
    return classifyLocation(ip, { geo: null, asn: null, isTorExit: false, asnClass: null });
  }
  const asnInfo = deps.asn(ip);
  return classifyLocation(ip, {
    geo: deps.geo(ip),
    asn: asnInfo,
    isTorExit: deps.torExits.has(ip),
    asnClass: asnInfo?.asn !== undefined ? deps.asnClass[String(asnInfo.asn)] ?? null : null,
  });
}

export async function resolveCatalogRegion(candidate: RegionCandidate): Promise<string> {
  const near = await storage.findNearestActiveRegion(candidate.latitude, candidate.longitude, CATALOG_MATCH_KM);
  if (near) return near.baseId;
  return (await storage.createDetectedRegionLocation(candidate)).baseId;
}
```

Call `startLocationServices()` once in `server/index.ts` during startup (after storage is ready, before routes registration).

- [ ] **Step 6: Run tests + quality gates**

Run: the vitest command from Step 4, then `npm run check && npm run lint`.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/location.ts server/storage.ts server/index.ts server/data/asn-classification.json shared/regions.ts package.json package-lock.json .gitignore tests/location.test.ts tests/location-catalog.test.ts
git commit -m "feat(location): mmdb/Tor/ASN detection shell + catalog nearest-or-create

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 4: `allocateSiteId` + agent-location application + marketplace seam

**Files:**
- Modify: `server/storage.ts` (factor allocator from `createEvalAgentTokenForLocation` ~line 485; new agent-location updates)
- Modify: `server/location.ts` (orchestrator `runAgentLocationCheck`)
- Modify: `server/marketplace.ts` (seam)
- Test: `tests/location-catalog.test.ts` (extend)

**Interfaces:**
- Consumes: `detectLocation`, `decideLocationTransition`, `resolveCatalogRegion` (Tasks 2–3).
- Produces:

```ts
// storage
allocateSiteId(baseId: string): Promise<string>; // e.g. "apac-in-mumbai-03"; throws on unknown/inactive region
updateEvalAgentLocation(agentId: number, fields: {
  region: string | null; siteId: string | null; locationTrust: string;
  locationCheckedAt: Date; locationSource: unknown;
  pendingRegion: string | null; pendingRegionCount: number;
}): Promise<void>;
updateEvalAgentLocationObservability(agentId: number, fields: {
  locationTrust: string; locationCheckedAt: Date; locationSource: unknown;
}): Promise<void>; // public-tier agents: never touches region/siteId/pending

// location.ts
export async function runAgentLocationCheck(opts: {
  agent: { id: number; region: string | null; siteId: string | null; pendingRegion: string | null; pendingRegionCount: number };
  token: { id: number; dispatchTier: string };
  ip: string | undefined;
  immediate: boolean;
}): Promise<{ region: string | null; siteId: string | null; locationTrust: LocationTrust }>;

// marketplace.ts
setListing(tokenId: number, pricePerUnit: number | null, meta?: { ownerId: number; region: string | null }): Promise<void>;
updateListingRegion(tokenId: number, region: string | null): Promise<void>; // NEW seam method
```

- [ ] **Step 1: Write failing tests**

Append to `tests/location-catalog.test.ts` (extend the vitest import with `beforeAll`):

```ts
import { evalAgents, evalAgentTokens } from "../shared/schema";
import { runAgentLocationCheck } from "../server/location";
import { hashToken } from "../server/storage";

describeDb("allocateSiteId + runAgentLocationCheck", () => {
  let tokenId: number;
  let agentId: number;

  beforeAll(async () => {
    const inserted = await db.insert(evalAgentTokens).values({
      name: "zt-loc-test", tokenHash: hashToken(`zt-loc-${Date.now()}`),
      dispatchTier: "private", createdBy: 1, isRevoked: false,
      siteId: null, region: null,
    }).returning();
    tokenId = inserted[0].id;
    const agent = await db.insert(evalAgents).values({
      name: "zt-loc-agent", tokenId, siteId: null, state: "idle",
    }).returning();
    agentId = agent[0].id;
  });
  afterAll(async () => {
    await db.delete(evalAgents).where(eq(evalAgents.id, agentId));
    await db.delete(evalAgentTokens).where(eq(evalAgentTokens.id, tokenId));
  });

  it("allocateSiteId hands out sequential ids and bumps next_sequence", async () => {
    const before = await storage.getRegionLocationByBaseId("eu-de-frankfurt");
    const siteId = await storage.allocateSiteId("eu-de-frankfurt");
    expect(siteId).toBe(`eu-de-frankfurt-${String(before!.nextSequence).padStart(2, "0")}`);
    const after = await storage.getRegionLocationByBaseId("eu-de-frankfurt");
    expect(after!.nextSequence).toBe(before!.nextSequence + 1);
  });

  it("runAgentLocationCheck immediate-assigns for a private agent (stub deps unavailable → uses stored detection path)", async () => {
    // No mmdbs in dev: a public IP classifies low_confidence/unknown → stays Unverified.
    const res = await runAgentLocationCheck({
      agent: { id: agentId, region: null, siteId: null, pendingRegion: null, pendingRegionCount: 0 },
      token: { id: tokenId, dispatchTier: "private" },
      ip: "8.8.8.8", immediate: true,
    });
    expect(res.region).toBeNull();
    expect(res.siteId).toBeNull();
    expect(["low_confidence", "unknown"]).toContain(res.locationTrust);
    const row = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(row.locationTrust).toBe(res.locationTrust);
    expect(row.locationCheckedAt).not.toBeNull();
  });

  it("public tier: observability only — region/siteId untouched", async () => {
    await db.update(evalAgents).set({ siteId: "na-us-seattle-01" }).where(eq(evalAgents.id, agentId));
    const res = await runAgentLocationCheck({
      agent: { id: agentId, region: null, siteId: "na-us-seattle-01", pendingRegion: null, pendingRegionCount: 0 },
      token: { id: tokenId, dispatchTier: "public" },
      ip: "8.8.8.8", immediate: true,
    });
    expect(res.siteId).toBe("na-us-seattle-01"); // identity preserved
    const row = (await db.select().from(evalAgents).where(eq(evalAgents.id, agentId)))[0];
    expect(row.siteId).toBe("na-us-seattle-01");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `set -a; . ./.env; . ./.env.dev; set +a; DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/location-catalog.test.ts`
Expected: FAIL — `allocateSiteId` / `runAgentLocationCheck` missing.

- [ ] **Step 3: Implement**

`storage.allocateSiteId` — extract the transaction body of `createEvalAgentTokenForLocation` (SELECT … FOR UPDATE, build `${baseId}-NN`, bump `next_sequence`) into:

```ts
  async allocateSiteId(baseId: string): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT base_id, next_sequence, is_active FROM region_locations WHERE base_id = $1 FOR UPDATE`,
        [baseId],
      );
      if (selected.rows.length === 0) throw new Error("Region location not found");
      if (!selected.rows[0].is_active) throw new Error("Region location is inactive");
      const sequence = Number(selected.rows[0].next_sequence);
      const siteId = `${selected.rows[0].base_id}-${String(sequence).padStart(2, "0")}`;
      await client.query(
        `UPDATE region_locations SET next_sequence = next_sequence + 1, updated_at = NOW() WHERE base_id = $1`,
        [baseId],
      );
      await client.query("COMMIT");
      return siteId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
```

Refactor `createEvalAgentTokenForLocation` to call `allocateSiteId(baseId)` first and then do a plain drizzle insert with that siteId + `region: baseId` (a burned sequence number on insert failure is harmless). Add the two `updateEvalAgentLocation*` methods as simple `db.update(evalAgents).set(...)` wrappers.

`runAgentLocationCheck` in `server/location.ts`:

```ts
export async function runAgentLocationCheck(opts: {
  agent: { id: number; region: string | null; siteId: string | null; pendingRegion: string | null; pendingRegionCount: number };
  token: { id: number; dispatchTier: string };
  ip: string | undefined;
  immediate: boolean;
}): Promise<{ region: string | null; siteId: string | null; locationTrust: LocationTrust }> {
  const det = detectLocation(opts.ip ?? "");
  const now = new Date();

  if (opts.token.dispatchTier === "public") {
    // Configured identity is trusted; detection is observability only.
    await storage.updateEvalAgentLocationObservability(opts.agent.id, {
      locationTrust: det.trust, locationCheckedAt: now, locationSource: det.source,
    });
    return { region: opts.agent.region, siteId: opts.agent.siteId, locationTrust: det.trust };
  }

  const baseId = det.candidate ? await resolveCatalogRegion(det.candidate) : null;
  const next = decideLocationTransition(opts.agent, { trust: det.trust, baseId }, { immediate: opts.immediate });
  let siteId = opts.agent.siteId;
  if (next.changed) {
    siteId = next.region ? await storage.allocateSiteId(next.region) : null;
  }
  await storage.updateEvalAgentLocation(opts.agent.id, {
    region: next.region, siteId, locationTrust: det.trust,
    locationCheckedAt: now, locationSource: det.source,
    pendingRegion: next.pendingRegion, pendingRegionCount: next.pendingRegionCount,
  });
  if (next.changed && opts.token.dispatchTier === "shared") {
    // Shared listings advertise the agent's siteId; keep the plugin in sync.
    const marketplace = getMarketplace();
    if (marketplace) await marketplace.updateListingRegion(opts.token.id, siteId);
  }
  return { region: next.region, siteId, locationTrust: det.trust };
}
```

(Import `getMarketplace` from `./marketplace`.)

`server/marketplace.ts`: change `setListing` meta type to `{ ownerId: number; region: string | null }` and add to the interface:

```ts
  /**
   * Zero-trust region: a shared agent's advertised region (its siteId) is
   * Vox-detected and mutable at runtime. Called whenever the agent's region is
   * assigned, re-assigned, or cleared; null = Unverified (delist from regional
   * pools until trusted).
   */
  updateListingRegion(tokenId: number, region: string | null): Promise<void>;
```

- [ ] **Step 4: Run tests + gates**

Run: the Step-2 vitest command, then `npm run check && npm run lint`.
Expected: PASS. (`npm run check` will flag every `setListing` caller and any plugin-host typing for the new interface method — update `server/routes.ts` call sites to pass `region: evalAgentToken.siteId ?? null` for now; Task 5 revisits them.)

- [ ] **Step 5: Commit**

```bash
git add server/storage.ts server/location.ts server/marketplace.ts server/routes.ts tests/location-catalog.test.ts
git commit -m "feat(location): siteId allocator + agent location application + listing-region seam

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 5: Zero-trust token mint

**Files:**
- Modify: `server/routes.ts` (`POST /api/eval-agent-tokens` ~2808, `POST /api/admin/eval-agent-tokens` ~2965)
- Modify: `server/storage.ts` (new `createEvalAgentTokenWithoutLocation`)
- Test: `tests/zero-trust-region-api.test.ts` (new)

**Interfaces:**
- Consumes: `validateTierChoice`, `createEvalAgentTokenForLocation`, `getMarketplace` (existing).
- Produces: `storage.createEvalAgentTokenWithoutLocation(token: Omit<InsertEvalAgentToken, "siteId">): Promise<EvalAgentToken>`; mint responses where `siteId` is `string | null`.

- [ ] **Step 1: Write failing tests**

Create `tests/zero-trust-region-api.test.ts` (copy the `login`/`authFetch` helpers verbatim from `tests/tier-pool-dispatch.test.ts` lines 1–20):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("no session cookie");
  return cookie.split(";")[0];
}
const authFetch = (cookie: string, url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers || {}), Cookie: cookie, "Content-Type": "application/json" } });

describe("zero-trust token mint", () => {
  let cookie: string;
  const created: number[] = [];

  beforeAll(async () => { cookie = await login(); });
  afterAll(async () => {
    for (const id of created) {
      await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens/${id}/revoke`, { method: "POST" });
    }
  });

  const mint = (body: Record<string, unknown>) =>
    authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens`, { method: "POST", body: JSON.stringify(body) });

  it("public tier still requires and honors a region (admin path unchanged)", async () => {
    const res = await mint({ name: `zt-pub-${Date.now()}`, regionLocationBaseId: "na-us-seattle", dispatchTier: "public" });
    expect(res.status).toBe(200);
    const token = await res.json();
    created.push(token.id);
    expect(token.siteId).toMatch(/^na-us-seattle-\d{2}$/);
  });

  it("public tier without a region → 400", async () => {
    const res = await mint({ name: `zt-pub-nr-${Date.now()}`, dispatchTier: "public" });
    expect(res.status).toBe(400);
  });

  it("non-public mint REJECTS a caller-supplied region (zero trust, never silently ignored)", async () => {
    const res = await mint({ name: `zt-priv-${Date.now()}`, regionLocationBaseId: "na-us-seattle", dispatchTier: "private" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/detected automatically/i);
  });

  it("non-public mint without a region succeeds with siteId null", async () => {
    const res = await mint({ name: `zt-priv-ok-${Date.now()}`, dispatchTier: "private" });
    expect(res.status).toBe(200);
    const token = await res.json();
    created.push(token.id);
    expect(token.siteId).toBeNull();
    expect(token.token).toMatch(/^[A-Za-z0-9_-]/); // secret still returned once
  });

  it("token list returns null siteId for non-public tokens", async () => {
    const list = await (await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens`)).json();
    const mine = list.find((t: { id: number }) => t.id === created[created.length - 1]);
    expect(mine.siteId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Restart the dev server first (`./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start` — Task 1–4 server changes must be live), then:
`set -a; . ./.env; . ./.env.dev; set +a; npx vitest run tests/zero-trust-region-api.test.ts`
Expected: the two non-public tests FAIL (today a region is required for every tier).

- [ ] **Step 3: Implement**

`storage.createEvalAgentTokenWithoutLocation`:

```ts
  async createEvalAgentTokenWithoutLocation(token: Omit<InsertEvalAgentToken, "siteId">): Promise<EvalAgentToken> {
    const result = await db.insert(evalAgentTokens).values({
      ...token, siteId: null, region: null,
    }).returning();
    return result[0];
  }
```

In BOTH mint routes (`/api/eval-agent-tokens` and `/api/admin/eval-agent-tokens`), replace the unconditional `if (!name || !requestedLocation) return 400` + `createEvalAgentTokenForLocation` block with tier-dependent logic (after `validateTierChoice`):

```ts
      if (!name) return res.status(400).json({ error: "Name required" });

      let evalAgentToken;
      if (dispatchTier === "public") {
        if (!requestedLocation) return res.status(400).json({ error: "Region location required for public agents" });
        const location = await storage.getRegionLocationByBaseId(String(requestedLocation));
        if (!location || !location.isActive) {
          return res.status(400).json({ error: "Invalid or inactive region location" });
        }
        evalAgentToken = await storage.createEvalAgentTokenForLocation(location.baseId, {
          name, tokenHash, dispatchTier, createdBy: user.id, isRevoked: false,
        });
      } else {
        // Zero trust: users never assert a region for non-public agents.
        if (requestedLocation) {
          return res.status(400).json({ error: "Region cannot be set for private/team/shared agents — it is detected automatically when the agent connects" });
        }
        evalAgentToken = await storage.createEvalAgentTokenWithoutLocation({
          name, tokenHash, dispatchTier, createdBy: user.id, isRevoked: false,
        });
      }
```

(Keep `const token = generateEvalAgentToken(); const tokenHash = hashToken(token);` above the branch. Shared-tier `setListing` call now passes `region: evalAgentToken.siteId ?? null` — null until the agent connects and earns trust.)

- [ ] **Step 4: Restart server, run tests + gates**

```bash
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
set -a; . ./.env; . ./.env.dev; set +a; npx vitest run tests/zero-trust-region-api.test.ts
npm run check && npm run lint
```
Expected: PASS. **Regression check:** `npx vitest run tests/tier-pool-dispatch.test.ts` still passes (dev daemon uses an admin-minted public token — unaffected).

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/storage.ts tests/zero-trust-region-api.test.ts
git commit -m "feat(mint): region is public-tier-only; non-public tokens mint region-less

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 6: Register + heartbeat detection wiring

**Files:**
- Modify: `server/routes.ts` (`/api/eval-agent/register` ~3267, `/api/eval-agent/heartbeat` ~3343, `/api/eval-agents` ~3171)
- Modify: `server/storage.ts` (`getEvalAgentsWithTokenTier` select — add `region`, `locationTrust`)
- Test: `tests/zero-trust-region-api.test.ts` (extend)

**Interfaces:**
- Consumes: `runAgentLocationCheck`, `LOCATION_RECHECK_HOURS` (Task 4/2).
- Produces: register response gains `region: string | null`, `locationTrust: string` (and `siteId` may be null); `/api/eval-agents` rows gain `region`, `locationTrust`.

- [ ] **Step 1: Write failing tests**

Append to `tests/zero-trust-region-api.test.ts`:

```ts
describe("register/heartbeat location detection", () => {
  let cookie: string; let tokenSecret: string; let tokenId: number; let agentId: number; let leaseId: string;

  beforeAll(async () => {
    cookie = await login();
    const res = await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens`, {
      method: "POST",
      body: JSON.stringify({ name: `zt-reg-${Date.now()}`, dispatchTier: "private" }),
    });
    const body = await res.json();
    tokenSecret = body.token; tokenId = body.id;
  });
  afterAll(async () => {
    await authFetch(cookie, `${BASE_URL}/api/eval-agent-tokens/${tokenId}/revoke`, { method: "POST" });
  });

  const agentFetch = (url: string, body: Record<string, unknown>) =>
    fetch(`${BASE_URL}${url}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("register runs detection: localhost → unknown, siteId null, Unverified", async () => {
    const res = await agentFetch("/api/eval-agent/register", { name: "zt-agent" });
    expect(res.status).toBe(200);
    const agent = await res.json();
    agentId = agent.id; leaseId = agent.leaseId;
    expect(agent.siteId).toBeNull();
    expect(agent.region).toBeNull();
    expect(agent.locationTrust).toBe("unknown"); // dev connects via 127.0.0.1
  });

  it("heartbeat keeps working for an Unverified agent", async () => {
    const res = await agentFetch("/api/eval-agent/heartbeat", { agentId, leaseId, state: "idle" });
    expect(res.status).toBe(200);
  });

  it("/api/eval-agents exposes locationTrust but never location_source", async () => {
    const list = await (await authFetch(cookie, `${BASE_URL}/api/eval-agents`)).json();
    const mine = list.find((a: { id: number }) => a.id === agentId);
    expect(mine).toBeDefined();
    expect(mine.locationTrust).toBe("unknown");
    expect(mine.region).toBeNull();
    expect(mine).not.toHaveProperty("locationSource");
    expect(mine).not.toHaveProperty("observedIp");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (server restarted from Task 5): `set -a; . ./.env; . ./.env.dev; set +a; npx vitest run tests/zero-trust-region-api.test.ts`
Expected: new describe FAILS (register response has no `region`/`locationTrust`; agents listing lacks the fields).

- [ ] **Step 3: Implement**

**Register route** — after the existing `updateEvalAgentHeartbeat(agent.id)` + `updateEvalAgentObservedIp` lines, replace the fire-and-forget IP write with an awaited location check and enrich the response:

```ts
      await storage.updateEvalAgentHeartbeat(agent.id);
      if (req.ip) void storage.updateEvalAgentObservedIp(agent.id, req.ip);

      // Zero-trust location: detection is the ONLY region source for
      // non-public agents; registration applies immediately (fresh process).
      const loc = await runAgentLocationCheck({
        agent: {
          id: agent.id,
          region: (agent as { region?: string | null }).region ?? null,
          siteId: agent.siteId ?? null,
          pendingRegion: (agent as { pendingRegion?: string | null }).pendingRegion ?? null,
          pendingRegionCount: (agent as { pendingRegionCount?: number }).pendingRegionCount ?? 0,
        },
        token: { id: evalAgentToken.id, dispatchTier: evalAgentToken.dispatchTier },
        ip: req.ip,
        immediate: true,
      });

      res.json({
        id: agent.id,
        name: agent.name,
        siteId: loc.siteId,
        region: loc.region,
        locationTrust: loc.locationTrust,
        state: agent.state,
        leaseId,
      });
```

Note: for a NEW agent row created in this route, `storage.createEvalAgent({...})` currently passes `siteId: evalAgentToken.siteId` — change to `siteId: evalAgentToken.siteId ?? null` (public keeps the configured site; non-public starts null).

**Heartbeat route** — after `updateEvalAgentHeartbeat(agentId)`, replace the observedIp line with:

```ts
      const ipChanged = !!req.ip && req.ip !== agent.observedIp;
      if (req.ip) void storage.updateEvalAgentObservedIp(agentId, req.ip);

      // Re-detect when the IP moved, the check is stale (>24h / never ran), or
      // a pending region change is mid-hysteresis (every beat counts it down —
      // the IP-change trigger alone would stall since observed_ip updates each
      // beat). Fire-and-forget: a slow catalog write must not delay the beat.
      const checkedAt = (agent as { locationCheckedAt?: Date | null }).locationCheckedAt;
      const stale = !checkedAt || (Date.now() - new Date(checkedAt).getTime()) > LOCATION_RECHECK_HOURS * 60 * 60 * 1000;
      const pending = (agent as { pendingRegion?: string | null }).pendingRegion != null;
      if (ipChanged || stale || pending) {
        void runAgentLocationCheck({
          agent: {
            id: agent.id,
            region: (agent as { region?: string | null }).region ?? null,
            siteId: agent.siteId ?? null,
            pendingRegion: (agent as { pendingRegion?: string | null }).pendingRegion ?? null,
            pendingRegionCount: (agent as { pendingRegionCount?: number }).pendingRegionCount ?? 0,
          },
          token: { id: evalAgentToken.id, dispatchTier: evalAgentToken.dispatchTier },
          ip: req.ip,
          immediate: false,
        }).catch((err) => console.error(`[location] heartbeat check failed for agent ${agent.id}:`, err instanceof Error ? err.message : err));
      }
```

(If `EvalAgent` drizzle types already include the new columns from Task 1, drop the `(agent as …)` casts and use the fields directly — they exist on the inferred type; the casts above are only illustrative for pre-Task-1 readers.)

**`/api/eval-agents`** — in `storage.getEvalAgentsWithTokenTier` add `region: evalAgents.region, locationTrust: evalAgents.locationTrust,` to the select; in the route's `res.json` map add `region: a.region, locationTrust: a.locationTrust,`. Do NOT add `locationSource` or `observedIp` anywhere.

Import `runAgentLocationCheck` and `LOCATION_RECHECK_HOURS` from `./location` in routes.ts.

- [ ] **Step 4: Restart server, run tests + gates**

```bash
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
set -a; . ./.env; . ./.env.dev; set +a; npx vitest run tests/zero-trust-region-api.test.ts
npm run check && npm run lint
```
Expected: PASS. Also confirm the local daemon (public token) still registers cleanly: `./scripts/dev-local-run.sh logs agent | tail -20` shows a successful register.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/storage.ts tests/zero-trust-region-api.test.ts
git commit -m "feat(agents): register/heartbeat run zero-trust location detection

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 7: Claim gating on effective identity + trust freeze

**Files:**
- Modify: `server/storage.ts` (`claimEvalJob` ~876, `getClaimableJobsForToken` ~930)
- Modify: `server/routes.ts` (jobs list ~3396, claim ~3451)
- Test: `tests/zero-trust-dispatch.test.ts` (new, DB-level)

**Interfaces:**
- Consumes: nullable agent identity (Task 6); `BASE_NA` from `tests/helpers/regions`.
- Produces (exact signatures):

```ts
// identity now tier-resolved by the CALLER; siteId/region nullable; trust travels with it
claimEvalJob(jobId: number, agentId: number, identity: {
  id: number; siteId: string | null; region: string | null; dispatchTier: string;
  createdBy: number; ownerOrgId: number | null; locationTrust: string;
}): Promise<EvalJob | undefined>;
getClaimableJobsForToken(identity: {
  id: number; siteId: string | null; region: string | null; dispatchTier: string;
  createdBy: number; ownerOrgId: number | null;
}): Promise<EvalJob[]>;
```

- [ ] **Step 1: Write failing tests**

Create `tests/zero-trust-dispatch.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { storage, db, hashToken } from "../server/storage";
import { evalAgents, evalAgentTokens, evalJobs } from "../shared/schema";
import { BASE_NA } from "./helpers/regions";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("zero-trust claim gating", () => {
  let tokenId: number; let agentId: number;
  const jobIds: number[] = [];

  const identity = (over: Partial<{ siteId: string | null; region: string | null; locationTrust: string }> = {}) => ({
    id: tokenId, siteId: null as string | null, region: null as string | null,
    dispatchTier: "private", createdBy: 1, ownerOrgId: null, locationTrust: "unknown", ...over,
  });

  const makeJob = async (fields: Partial<typeof evalJobs.$inferInsert>) => {
    const row = await db.insert(evalJobs).values({
      workflowId: null, evalSetId: null, createdBy: 1, status: "pending",
      config: {}, snapshot: {}, siteId: null, ...fields,
    } as typeof evalJobs.$inferInsert).returning();
    jobIds.push(row[0].id);
    return row[0];
  };

  beforeAll(async () => {
    const t = await db.insert(evalAgentTokens).values({
      name: "zt-claim", tokenHash: hashToken(`zt-claim-${Date.now()}`),
      dispatchTier: "private", createdBy: 1, isRevoked: false, siteId: null, region: null,
    }).returning();
    tokenId = t[0].id;
    const a = await db.insert(evalAgents).values({ name: "zt-claim-agent", tokenId, siteId: null, state: "idle" }).returning();
    agentId = a[0].id;
  });
  afterAll(async () => {
    if (jobIds.length) await db.delete(evalJobs).where(inArray(evalJobs.id, jobIds));
    await db.delete(evalAgents).where(eq(evalAgents.id, agentId));
    await db.delete(evalAgentTokens).where(eq(evalAgentTokens.id, tokenId));
  });

  it("an Unverified agent (region NULL) cannot see or claim a region-pooled job", async () => {
    const job = await makeJob({ targetRegion: BASE_NA, targetTier: "private" });
    const visible = await storage.getClaimableJobsForToken(identity());
    expect(visible.map(j => j.id)).not.toContain(job.id);
    expect(await storage.claimEvalJob(job.id, agentId, identity())).toBeUndefined();
  });

  it("a trusted agent in the pool region claims it, freezing location_trust + its siteId", async () => {
    const job = await makeJob({ targetRegion: BASE_NA, targetTier: "private" });
    const id = identity({ region: BASE_NA, siteId: `${BASE_NA}-77`, locationTrust: "trusted" });
    const visible = await storage.getClaimableJobsForToken(id);
    expect(visible.map(j => j.id)).toContain(job.id);
    const claimed = await storage.claimEvalJob(job.id, agentId, id);
    expect(claimed?.siteId).toBe(`${BASE_NA}-77`);
    expect(claimed?.locationTrust).toBe("trusted");
  });

  it("a targeted job IS claimable by an Unverified agent — siteId stays NULL, trust frozen", async () => {
    const job = await makeJob({ targetTokenId: tokenId });
    const claimed = await storage.claimEvalJob(job.id, agentId, identity({ locationTrust: "anonymized" }));
    expect(claimed).toBeDefined();
    expect(claimed?.siteId).toBeNull();
    expect(claimed?.locationTrust).toBe("anonymized");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `set -a; . ./.env; . ./.env.dev; set +a; DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/zero-trust-dispatch.test.ts`
Expected: FAIL — `claimEvalJob` has no `locationTrust` param / returned job has no `locationTrust`.

- [ ] **Step 3: Implement**

`storage.claimEvalJob`: rename the param `token` → `identity`, widen `siteId`/`region` to `string | null`, add `locationTrust: string`. The SELECT predicate is unchanged (a NULL `$3`/`$7` simply never matches the pooled/legacy arms — that IS the gate). The UPDATE becomes:

```sql
UPDATE eval_jobs
SET eval_agent_id = $1, status = 'running'::eval_job_status, started_at = NOW(), updated_at = NOW(),
    token_dispatch_tier = $3,
    site_id = COALESCE(site_id, $4),
    location_trust = $5
WHERE id = $2
RETURNING *
```

with params `[agentId, jobId, identity.dispatchTier, identity.siteId, identity.locationTrust]`.

`storage.getClaimableJobsForToken`: widen `siteId`/`region` to `string | null` (SQL unchanged — NULL params exclude pooled/legacy arms; targeted arm `target_token_id = $1` still matches).

`server/routes.ts` — add one helper near `isSupersededLease` (~3236):

```ts
  // Zero-trust effective dispatch identity: public agents carry their
  // configured (admin-trusted) token region; everything else carries the
  // agent's DETECTED region — NULL for Unverified, which structurally fails
  // every region-pooled match. (spec: dispatch gating)
  const effectiveDispatchIdentity = (
    token: { siteId: string | null; region: string | null; dispatchTier: string },
    agent: { siteId: string | null; region: string | null; locationTrust: string } | undefined,
  ) => token.dispatchTier === "public"
    ? { siteId: token.siteId, region: token.region, locationTrust: "trusted" }
    : { siteId: agent?.siteId ?? null, region: agent?.region ?? null, locationTrust: agent?.locationTrust ?? "unknown" };
```

Jobs-list route (~3412): replace `siteId: evalAgentToken.siteId, region: evalAgentToken.region,` with the helper output using `latestAgent` (which the route already loads a few lines below — hoist that load above the call).

Claim route (~3496): build the identity from the CLAIMING agent row (`agent`), pass `...effectiveDispatchIdentity(evalAgentToken, agent), id: evalAgentToken.id, dispatchTier: evalAgentToken.dispatchTier, createdBy, ownerOrgId`. The site-fence above it (`existingJob.siteId != null && existingJob.siteId !== agent.siteId`) stays — for public agents compare against the token's siteId instead: `const eff = effectiveDispatchIdentity(evalAgentToken, agent); if (existingJob.siteId != null && existingJob.siteId !== eff.siteId) …`.

- [ ] **Step 4: Run tests + regressions + gates**

```bash
set -a; . ./.env; . ./.env.dev; set +a
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/zero-trust-dispatch.test.ts
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/tier-pool-dispatch.test.ts tests/dispatch-integration.test.ts
npm run check && npm run lint
```
Expected: all PASS (public-agent flows unchanged: token still carries its configured identity).

- [ ] **Step 5: Commit**

```bash
git add server/storage.ts server/routes.ts tests/zero-trust-dispatch.test.ts
git commit -m "feat(dispatch): claim uses tier-resolved effective identity, freezes location_trust

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 8: Metrics — community trust gate, unverified scope, available regions

**Files:**
- Modify: `server/storage.ts` (`RegionQueryScope` ~121, `regionScopeCondition` ~1473, `communityConditions` ~1503; new `getAvailableRegions`)
- Modify: `server/routes.ts` (`parseRegionQueryScope` ~126; new `GET /api/metrics/available-regions` next to the other metrics routes ~4798)
- Test: `tests/zero-trust-metrics.test.ts` (new, DB-level)

**Interfaces:**
- Produces:

```ts
export type RegionQueryScope = { siteId?: string; baseIds?: string[]; unverified?: boolean };
// storage
getAvailableRegions(tier: MetricTier, hoursBack?: number, userId?: number): Promise<{ baseIds: string[]; hasUnverified: boolean }>;
// route
GET /api/metrics/available-regions?tier=realtime|community|my-evals&hours=N
  → 200 { availableRegions: string[], hasUnverified: boolean }   (my-evals: requires auth; hasUnverified always false for the public tiers)
```

**Spec deviation (ruled):** the spec says each metrics response "gains `availableRegions`"; changing those responses' shape breaks existing clients/tests, so the same information ships as a sibling endpoint. Same data, non-breaking — record in the ledger.

- [ ] **Step 1: Write failing tests**

Create `tests/zero-trust-metrics.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { storage, db } from "../server/storage";
import { evalJobs, evalResults, providers } from "../shared/schema";
import { BASE_NA, BASE_EU } from "./helpers/regions";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("zero-trust metrics gates", () => {
  const jobIds: number[] = []; const resultIds: number[] = [];
  let providerId: string;
  let publicSnap: Record<string, unknown>;

  // seed one completed job+result per case (NB: the results FK column is
  // evalJobId, and providerId must be a REAL seeded provider id)
  const seed = async (over: {
    tier: "public" | "shared"; trust: string | null; siteId: string | null;
  }) => {
    const job = (await db.insert(evalJobs).values({
      createdBy: 1, status: "completed", config: {}, snapshot: publicSnap,
      tokenDispatchTier: over.tier, locationTrust: over.trust, siteId: over.siteId,
    } as typeof evalJobs.$inferInsert).returning())[0];
    jobIds.push(job.id);
    const result = (await db.insert(evalResults).values({
      evalJobId: job.id, providerId, siteId: over.siteId,
      responseLatencyMedian: 500,
    } as typeof evalResults.$inferInsert).returning())[0];
    resultIds.push(result.id);
    return result.id;
  };

  let trustedShared: number, anonShared: number, legacyShared: number, unverifiedMine: number;

  beforeAll(async () => {
    providerId = (await db.select().from(providers).limit(1))[0].id;
    publicSnap = {
      workflow: { visibility: "public", isMainline: false, ownerId: 1 },
      evalSet: { visibility: "public", isMainline: false, ownerId: 1 },
      provider: { id: providerId }, creatorPlan: "premium",
    };
    trustedShared = await seed({ tier: "shared", trust: "trusted", siteId: `${BASE_NA}-88` });
    anonShared    = await seed({ tier: "shared", trust: "anonymized", siteId: `${BASE_EU}-88` });
    legacyShared  = await seed({ tier: "shared", trust: null, siteId: `${BASE_NA}-89` });
    unverifiedMine = await seed({ tier: "shared", trust: "anonymized", siteId: null });
  });
  afterAll(async () => {
    await db.delete(evalResults).where(inArray(evalResults.id, resultIds));
    await db.delete(evalJobs).where(inArray(evalJobs.id, jobIds));
  });

  it("community includes trusted + legacy(NULL) shared rows, excludes anonymized", async () => {
    const rows = await storage.getCommunityMetrics(undefined, undefined);
    const ids = rows.map(r => r.id);
    expect(ids).toContain(trustedShared);
    expect(ids).toContain(legacyShared);
    expect(ids).not.toContain(anonShared);
    expect(ids).not.toContain(unverifiedMine); // no region AND untrusted
  });

  it("unverified scope selects NULL-siteId rows for my-evals", async () => {
    const rows = await storage.getMyEvalMetrics(1, undefined, { unverified: true });
    expect(rows.map(r => r.id)).toContain(unverifiedMine);
    expect(rows.map(r => r.id)).not.toContain(trustedShared);
  });

  it("unverified + baseIds compose as OR", async () => {
    const rows = await storage.getMyEvalMetrics(1, undefined, { baseIds: [BASE_NA], unverified: true });
    const ids = rows.map(r => r.id);
    expect(ids).toContain(unverifiedMine);
    expect(ids).toContain(trustedShared);
  });

  it("getAvailableRegions strips the site suffix and reports hasUnverified", async () => {
    const avail = await storage.getAvailableRegions("myEvals", undefined, 1);
    expect(avail.baseIds).toContain(BASE_NA);
    expect(avail.hasUnverified).toBe(true);
    const community = await storage.getAvailableRegions("community");
    expect(community.baseIds).toContain(BASE_NA);
    expect(community.baseIds).not.toContain(`${BASE_NA}-88`); // baseIds, not siteIds
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `set -a; . ./.env; . ./.env.dev; set +a; DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/zero-trust-metrics.test.ts`
Expected: FAIL — community includes `anonShared`; `unverified` scope / `getAvailableRegions` missing. (If `getMyEvalMetrics` filters on snapshot ownerId — adjust `publicSnap.workflow.ownerId`/`evalSet.ownerId` to 1 as written so admin user 1 owns them; read `myEvalConditions` ~1529 first and mirror the fields it actually checks.)

- [ ] **Step 3: Implement**

`regionScopeCondition`:

```ts
  private regionScopeCondition(scope?: RegionQueryScope) {
    if (!scope) return undefined;
    if (scope.siteId) return eq(evalResults.siteId, scope.siteId);
    const parts = [];
    if (scope.baseIds && scope.baseIds.length > 0) {
      parts.push(or(...scope.baseIds.map((baseId) => sql<boolean>`${evalResults.siteId} LIKE ${baseId + "-%"}`)));
    }
    if (scope.unverified) parts.push(isNull(evalResults.siteId));
    if (scope.baseIds && scope.baseIds.length === 0 && !scope.unverified) return sql<boolean>`false`;
    if (parts.length === 0) return undefined;
    return parts.length === 1 ? parts[0] : or(...parts);
  }
```

`communityConditions` — append one condition (import `isNull`, `inArray` already available):

```ts
      // Zero-trust gate: only region-trusted agents feed the public community
      // board; public agents are configured (admin-trusted); NULL grandfathers
      // pre-feature rows (history never reclassifies).
      or(
        eq(evalJobs.tokenDispatchTier, "public"),
        sql`${evalJobs.locationTrust} IS NULL`,
        inArray(evalJobs.locationTrust, ["trusted", "datacenter"]),
      ),
```

`getAvailableRegions` — mirror the join skeleton of the existing tier query methods (results ⋈ jobs), reusing `tierConditions(tier, hoursBack, userId)` with NO scope:

```ts
  async getAvailableRegions(tier: MetricTier, hoursBack?: number, userId?: number): Promise<{ baseIds: string[]; hasUnverified: boolean }> {
    const conditions = this.tierConditions(tier, hoursBack, userId);
    const rows = await db
      .select({
        baseId: sql<string | null>`regexp_replace(${evalResults.siteId}, '-\\d+$', '')`,
        n: sql<number>`count(*)`,
      })
      .from(evalResults)
      .innerJoin(evalJobs, eq(evalResults.evalJobId, evalJobs.id))
      .where(and(...conditions))
      .groupBy(sql`regexp_replace(${evalResults.siteId}, '-\\d+$', '')`);
    return {
      baseIds: rows.filter(r => r.baseId != null).map(r => r.baseId as string).sort(),
      hasUnverified: rows.some(r => r.baseId == null),
    };
  }
```

(Match the actual join/condition pattern used by `tierBucketedDaily` ~1589 — if it joins through more tables, copy that skeleton instead; the conditions builder is the source of truth.)

`parseRegionQueryScope` in routes.ts — inside the `regionScope` branch, before the `level:value` parsing loop, handle the literal entry:

```ts
    let unverified = false;
    const hierScopes = scopes.filter((s) => {
      if (s.trim() === "unverified") { unverified = true; return false; }
      return true;
    });
```

…iterate `hierScopes` instead of `scopes`, and return `{ scope: { baseIds: sortedBaseIds, ...(unverified ? { unverified } : {}) }, cacheKey: \`scopes:${sortedBaseIds.join(",")}${unverified ? "+unverified" : ""}\` }`. When `hierScopes` is empty but `unverified` is set, return `{ scope: { unverified: true }, cacheKey: "unverified" }` (skip the "must contain scopes" error in that case).

New route (after the my-evals metrics route):

```ts
  app.get("/api/metrics/available-regions", async (req, res) => {
    try {
      const tierParam = String(req.query.tier ?? "");
      const tierMap: Record<string, MetricTier> = { realtime: "mainline", community: "community", "my-evals": "myEvals" };
      const tier = tierMap[tierParam];
      if (!tier) return res.status(400).json({ error: "tier must be realtime, community, or my-evals" });
      const win = parseMetricsWindow(req.query.hours);
      if ("error" in win) return res.status(400).json({ error: win.error });
      let userId: number | undefined;
      if (tier === "myEvals") {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Not authenticated" });
        userId = user.id;
      }
      const cacheKey = `avail:${tierParam}:${win.hoursBack ?? "all"}:${userId ?? ""}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);
      const { baseIds, hasUnverified } = await storage.getAvailableRegions(tier, win.hoursBack, userId);
      const data = { availableRegions: baseIds, hasUnverified: tier === "myEvals" ? hasUnverified : false };
      setCache(cacheKey, data);
      res.json(data);
    } catch (error) {
      console.error("Error fetching available regions:", error);
      res.status(500).json({ error: "Failed to fetch available regions" });
    }
  });
```

(Import `MetricTier` type from `./storage` if not already.)

- [ ] **Step 4: Run tests + regressions + gates**

```bash
set -a; . ./.env; . ./.env.dev; set +a
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npx vitest run tests/zero-trust-metrics.test.ts tests/tier-classification*.test.ts
npm run check && npm run lint
```
Expected: PASS (existing tier-classification suites confirm mainline/my-evals unaffected and community grandfathering holds).

- [ ] **Step 5: Commit**

```bash
git add server/storage.ts server/routes.ts tests/zero-trust-metrics.test.ts
git commit -m "feat(metrics): community trust gate, unverified scope, available-regions endpoint

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 9: Console — tier-gated mint dialog + trust badges

**Files:**
- Modify: `client/src/pages/console-eval-agents.tsx`

**Interfaces:**
- Consumes: `/api/eval-agents` rows now carrying `region: string | null`, `locationTrust: string` (Task 6); mint API rejecting regions for non-public (Task 5).

- [ ] **Step 1: Update the local row interfaces** (~lines 34/46): `siteId: string | null;` and add `region?: string | null; locationTrust?: string;` to the agent interface.

- [ ] **Step 2: Tier-gate the region picker in the mint dialog**

Around the existing region `Select` in the create form (near the `dispatchTier` Select ~386): render the region picker only when `dispatchTier === "public"`; otherwise show:

```tsx
{dispatchTier === "public" ? (
  /* existing region <Select> unchanged */
) : (
  <p className="text-xs text-muted-foreground" data-testid="text-region-auto">
    Region is detected automatically when the agent connects — it cannot be set manually.
  </p>
)}
```

In the create mutation body (~126): only include the region for public:

```ts
const body: Record<string, unknown> = { name, dispatchTier };
if (dispatchTier === "public") body.regionLocationBaseId = region;
```

Disable the submit button's region requirement for non-public tiers (the existing `disabled` expression must not demand a region unless `dispatchTier === "public"`).

- [ ] **Step 3: Trust badge + "auto" siteId**

Add a small helper next to `getTierBadge`:

```tsx
const getTrustBadge = (trust?: string, tier?: string) => {
  if (tier === "public") return null; // configured, no badge needed
  if (trust === "trusted") return <Badge variant="outline" className="text-green-600 border-green-600">Verified</Badge>;
  if (trust === "datacenter") return <Badge variant="outline" className="text-green-600 border-green-600">Verified · datacenter</Badge>;
  return <Badge variant="outline" className="text-yellow-600 border-yellow-600">Unverified</Badge>;
};
```

Render it beside the tier badge in the agents list (~260). Wherever `formatSite(agent.siteId)` / `formatSite(token.siteId)` renders (~256/509), handle null: `agent.siteId ? formatSite(agent.siteId) : "auto"`.

- [ ] **Step 4: Verify**

Run: `npm run check && npm run lint`. Then manually: open `http://localhost:5000/console/eval-agents` (admin login), switch the mint dialog tier between public/private and confirm the picker toggles; confirm existing agents render (public agents badge-less, any non-public agent shows Unverified).
Expected: PASS + visual confirmation.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/console-eval-agents.tsx
git commit -m "feat(console): tier-gated region picker + agent trust badges

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 10: Metrics UI — fixed mainline tree vs dynamic trees + Unverified node

**Files:**
- Modify: `client/src/lib/utils.ts` (`RegionLocation` interface ~33, scope helpers ~102–190)
- Modify: `client/src/components/region-scope-selector.tsx`
- Modify: `client/src/pages/realtime.tsx`
- Modify: `client/src/pages/admin-regions.tsx`

**Interfaces:**
- Consumes: `GET /api/metrics/available-regions` (Task 8); `region_locations.isMainline/source` via `/api/region-locations` (server serializer already spreads the full row — verify `serializeRegionLocation` in routes.ts ~116 includes the new columns via `...location`; it does).
- Produces: `RegionScopeSelector` prop `showUnverified?: boolean`; scope entry literal `"unverified"` flowing through `regionScope=` query param (Task 8 parser accepts it).

- [ ] **Step 1: Client type + helpers**

`client/src/lib/utils.ts` — add to `RegionLocation`: `latitude?: number | null; longitude?: number | null; source?: string; isMainline?: boolean;`.

Make the three scope helpers unverified-aware:
- `resolveRegionScopeBaseIds`: ignore `"unverified"` entries (it resolves geographic baseIds only).
- `toggleRegionScopeSelection`: pass `"unverified"` entries through untouched — extract them first, run the existing logic on the rest, re-append: at the top `const unverifiedScopes = currentScopes.filter(s => s === "unverified"); const geoScopes = currentScopes.filter(s => s !== "unverified");`, operate on `geoScopes`, and return `[...result, ...unverifiedScopes]` (dedup).
- `formatRegionScopeSelection`: map `"unverified"` → label `"Unverified"`.

Add one tiny helper:

```ts
export function toggleUnverifiedScope(currentScopes: string[]): string[] {
  const withoutAll = currentScopes.filter((s) => s !== "all");
  return withoutAll.includes("unverified")
    ? (withoutAll.filter((s) => s !== "unverified").length ? withoutAll.filter((s) => s !== "unverified") : ["all"])
    : [...withoutAll, "unverified"];
}
```

- [ ] **Step 2: `RegionScopeSelector` gains an Unverified node**

Add props `showUnverified?: boolean`. When true, render above the macro tree (inside the popover list) a checkbox row:

```tsx
{showUnverified && (
  <label className="flex items-center gap-2 px-1 py-1 rounded hover:bg-accent cursor-pointer text-sm" data-testid="region-scope-unverified">
    <Checkbox
      checked={value.includes("unverified")}
      onCheckedChange={() => onChange(toggleUnverifiedScope(value))}
    />
    <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5 opacity-60" />Unverified</span>
  </label>
)}
```

(Import `toggleUnverifiedScope` from `@/lib/utils`.)

- [ ] **Step 3: Per-tab trees in `realtime.tsx`**

After the existing `useRegionLocations()` (~788), add:

```tsx
const availabilityTier = activeTab === "mainline" ? "realtime" : activeTab === "community" ? "community" : "my-evals";
const { data: regionAvailability } = useQuery<{ availableRegions: string[]; hasUnverified: boolean }>({
  queryKey: ["/api/metrics/available-regions", availabilityTier, timeRange],
  queryFn: async () => {
    const params = new URLSearchParams({ tier: availabilityTier });
    if (timeRange !== "all") params.set("hours", timeRange);
    const res = await fetch(`/api/metrics/available-regions?${params}`, { credentials: "include" });
    if (!res.ok) throw new Error("available-regions failed");
    return res.json();
  },
  enabled: activeTab !== "my-evals" || isAuthenticated, // match however my-evals metrics gate auth in this file
});

const visibleLocations = useMemo(() => {
  const all = regionLocations ?? [];
  // Mainline: the fixed admin-curated set — shown even with no data (the gap
  // IS the signal). Community/My Evals: only cities that actually have data.
  if (activeTab === "mainline") return all.filter((l) => l.isMainline);
  const avail = new Set(regionAvailability?.availableRegions ?? []);
  return all.filter((l) => avail.has(l.baseId));
}, [regionLocations, activeTab, regionAvailability]);
```

(If this file has no `isAuthenticated` flag, reuse whatever condition already gates the `/api/metrics/my-evals` query a few lines above — copy it.) Pass to the selector (~949):

```tsx
<RegionScopeSelector
  locations={visibleLocations}
  value={regionScopes}
  onChange={setRegionScopes}
  showUnverified={activeTab === "my-evals" && !!regionAvailability?.hasUnverified}
/>
```

Reset selections that reference now-hidden regions when the tab changes: add an effect that, when `activeTab` changes, calls `setRegionScopes(["all"])`.

- [ ] **Step 4: Admin regions page**

In `client/src/pages/admin-regions.tsx`: display `source` ("configured"/"detected") and an `isMainline` toggle per row that PATCHes `/api/admin/region-locations/:id` with `{ isMainline: boolean }`. Server side: confirm the PATCH route (~routes.ts 993) passes body fields through `insertRegionLocationSchema.partial()` or explicit pick — if it whitelists fields, add `isMainline`, `latitude`, `longitude` to the whitelist (NOT `source`, which stays server-controlled).

- [ ] **Step 5: Verify**

`npm run check && npm run lint`; then in the browser: Mainline tab shows exactly the five mainline cities regardless of data; Community tab's tree shrinks to cities with data; My Evals shows the Unverified checkbox only when unverified data exists; selecting it appends `regionScope=unverified` (network tab) and the request succeeds.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/utils.ts client/src/components/region-scope-selector.tsx client/src/pages/realtime.tsx client/src/pages/admin-regions.tsx server/routes.ts
git commit -m "feat(ui): fixed mainline region tree, dynamic community/my-evals trees, Unverified node

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 11: geoip-refresh script, docs, E2E

**Files:**
- Create: `scripts/geoip-refresh.sh`
- Modify: `CLAUDE.md` (env vars section)
- Create: `tests/e2e/agent-region.spec.ts`

- [ ] **Step 1: `scripts/geoip-refresh.sh`**

```bash
#!/usr/bin/env bash
# Download/refresh GeoLite2 databases for the zero-trust agent-region pipeline.
# Requires MAXMIND_LICENSE_KEY (free GeoLite2 account). Run weekly (cron /
# Coolify scheduled command). Missing DBs are non-fatal at runtime: agents
# simply stay Unverified.
set -euo pipefail

: "${MAXMIND_LICENSE_KEY:?Set MAXMIND_LICENSE_KEY (https://www.maxmind.com → GeoLite2 free account)}"
GEOIP_DB_DIR="${GEOIP_DB_DIR:-$(pwd)/geoip}"
mkdir -p "$GEOIP_DB_DIR"

for edition in GeoLite2-City GeoLite2-ASN; do
  echo "Fetching ${edition}..."
  tmp=$(mktemp -d)
  curl -fsSL "https://download.maxmind.com/app/geoip_download?edition_id=${edition}&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz" \
    -o "${tmp}/${edition}.tar.gz"
  tar -xzf "${tmp}/${edition}.tar.gz" -C "$tmp"
  find "$tmp" -name "${edition}.mmdb" -exec mv {} "${GEOIP_DB_DIR}/" \;
  rm -rf "$tmp"
  echo "  → ${GEOIP_DB_DIR}/${edition}.mmdb"
done
echo "Done. Restart the Vox server to load the new databases."
```

`chmod +x scripts/geoip-refresh.sh`.

- [ ] **Step 2: CLAUDE.md env vars**

Under "Optional" env vars add:

```
- `GEOIP_DB_DIR` - Directory holding GeoLite2-City.mmdb + GeoLite2-ASN.mmdb (default: `./geoip`). Absent DBs = all non-public agents stay Unverified (safe default; local dev needs no MaxMind account)
- `MAXMIND_LICENSE_KEY` - Free GeoLite2 license key, consumed by `scripts/geoip-refresh.sh` (run weekly) — not read by the server itself
```

- [ ] **Step 3: E2E spec**

Create `tests/e2e/agent-region.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

// Zero-trust region: the mint dialog must not offer a region for non-public
// tiers (server rejects it anyway — the UI never offers what would 400).
// No token is actually minted: dialog-only, zero DB pollution.
test.describe("eval-agent token mint dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");
    await page.fill('input[type="email"], input[name="email"], input[placeholder*="email" i]', "admin@vox.local");
    await page.fill('input[type="password"]', "admin123456");
    await page.click('button[type="submit"]');
    await page.waitForURL(/console|\//, { timeout: 10000 });
    await page.goto("/console/eval-agents");
    await page.waitForLoadState("domcontentloaded");
  });

  test("non-public tier hides the region picker and explains auto-detection", async ({ page }) => {
    // Open the create-token dialog (button text per console-eval-agents.tsx).
    await page.getByRole("button", { name: /create|new token/i }).first().click();
    // Default tier for admin is public → region picker visible.
    await expect(page.getByText(/region/i).first()).toBeVisible();
    // Switch tier to private.
    await page.getByRole("combobox").filter({ hasText: /public/i }).first().click();
    await page.getByRole("option", { name: /private/i }).click();
    await expect(page.getByTestId("text-region-auto")).toBeVisible();
  });
});
```

(Adapt the two locators to the dialog's actual button label and tier-select markup from Task 9 — run with `--headed` once if they need adjusting; the assertion contract is: private tier → `text-region-auto` visible, no region select.)

- [ ] **Step 4: Run + gates**

```bash
npx playwright test tests/e2e/agent-region.spec.ts
npm run check && npm run lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/geoip-refresh.sh CLAUDE.md tests/e2e/agent-region.spec.ts
git commit -m "feat(ops): geoip-refresh script, env docs, mint-dialog e2e

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 12: Run-dialog agent picker — two-level region tree

**Files:**
- Modify: `client/src/pages/console-workflow-detail.tsx` (run dialog: region select ~238, tier select ~254, agent select ~290, submit body ~150)
- Modify: `server/routes.ts` (the `/api/workflows/:id/run-targets` endpoint — locate with `grep -n "run-targets" server/routes.ts` and read the full handler before changing it)
- Test: extend `tests/zero-trust-region-api.test.ts`

**Interfaces:**
- Consumes: agents carrying detected `region`/`siteId`/`locationTrust` (Task 6); effective-identity claim rules (Task 7); run body wire contract (UNCHANGED): `targetTokenId` XOR `{ region, targetTier }`.
- Produces: `run-targets` response extended so the client can build the tree — each agent row must carry `siteId: string | null`, `region: string | null` (baseId), `dispatchTier`, `locationTrust`; plus whatever per-tier availability the handler already returns, untouched.

**Spec section:** "Run dialog — agent picker (task creation)" in the design doc — read it first; it is the authority for this task. Requirements:

1. The run dialog presents available agents as a **two-level tree**: region nodes → siteId leaves, only regions/sites with a dispatchable agent (derive from the run-targets response; group agents by `region` baseId, sites are the agents' `siteId`s).
2. **Public tier:** region node selectable → submit `{ region, targetTier: "public" }`. Public siteId leaves are rendered but disabled (informational only).
3. **Private/team/shared:** region node selectable (pool dispatch `{ region, targetTier }`) OR siteId leaf selectable (targeted dispatch → submit `{ targetTokenId }` of the token behind that agent; the run-targets rows already carry `tokenId`).
4. **Unverified group:** private/team agents with `siteId === null` appear under an "Unverified" group at the bottom, selectable → targeted dispatch by `tokenId`. Shared agents with `siteId === null` are excluded entirely.
5. The wire contract does not change — the server run route needs no edits; only run-targets (response fields) and the client change.

- [ ] **Step 1: Read the current run-targets handler and the dialog code** (files above). Understand the existing response shape (`{ tiers: [...], agents: { mine: [...], shared: [...] } }` per the client's usage at console-workflow-detail.tsx:92–134) before touching it.

- [ ] **Step 2: Write failing API test** — append to `tests/zero-trust-region-api.test.ts` a describe that calls run-targets for a workflow (create one in beforeAll like tests/tier-pool-dispatch.test.ts does) and asserts each returned agent row has `siteId`, `region`, `dispatchTier`, and `locationTrust` keys (null allowed), and that no `locationSource`/`observedIp` keys leak. Run it, verify it fails on the missing keys.

- [ ] **Step 3: Extend run-targets** — add the four fields to each agent row from the agent rows the handler already loads (join through `getEvalAgentsWithTokenTier` fields; do NOT add new DB round-trips if the handler already has the data). Shared agents with `siteId === null` must be filtered out server-side (spec req 4).

- [ ] **Step 4: Restart dev server, verify the test passes.**

- [ ] **Step 5: Rebuild the dialog picker** — replace the flat region/tier/agent selects with the two-level tree per requirements 1–4. Reuse the grouping idiom from `region-scope-selector.tsx` (macro grouping optional — region → site is the required hierarchy; a flat list of region groups is acceptable). Selection state: either `{ kind: "region", region, targetTier }` or `{ kind: "site", tokenId }`; submit body per requirement 2/3. Keep the existing no-pool-available warning behavior (currently keyed off `runTargets.tiers`) working for region selections.

- [ ] **Step 6: Verify** — `npm run check && npm run lint`; manual pass in the browser: public workflow run offers region nodes with disabled public leaves; a private agent's site leaf submits targetTokenId (confirm in the network tab).

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/console-workflow-detail.tsx server/routes.ts tests/zero-trust-region-api.test.ts
git commit -m "feat(run): two-level region/siteId agent picker, zero-trust aware

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 13: Full gate

- [ ] **Step 1: Clean pollution + restart** (per `CLAUDE.md` known-hazard block)

```bash
docker exec vox-postgres psql -U vox -d vox -c "DELETE FROM clash_matches; DELETE FROM clash_events; DELETE FROM workflows WHERE owner_id=1; DELETE FROM projects WHERE owner_id=1; DELETE FROM secrets WHERE user_id=1;"
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
```

- [ ] **Step 2: Run the full pre-merge gate**

Run: `./scripts/full-tests-run.sh`
Expected: unit + audio + E2E green. Known environmental failure classes (order-dependence, agora-e2e flake, rotating redirect assertions) — re-run any single failing file in isolation before attributing it to this branch.

- [ ] **Step 3: Commit any final fixes; do NOT merge** — merging happens only on the user's explicit mark (project convention).
