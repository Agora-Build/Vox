# Zero-Trust Agent Region — Design

**Date:** 2026-09-01
**Status:** Draft for review
**Depends on:** region→siteId refactor (migration 0033), tier targeting (migration 0034)

## Principle

**Users must never be able to self-assert a region for benchmark data that Vox
presents as geographically trusted.**

- **Public agents** (admin-created, admin-deployed): region is **configured** at
  token mint and trusted, exactly as today.
- **Private / team / shared agents**: region is **observed**. The user cannot
  specify one anywhere in the lifecycle — not at token mint, not at
  registration. Vox detects the location from the agent's observed public IP,
  scores how trustworthy that IP is for geolocation, and only a
  location-eligible agent gets a region and a siteId.
- Location carries a graded **trust status**, not an `isVPN` boolean.
- An agent whose IP is not trustworthy still works for its owner's own evals,
  labeled **Unverified**; it never contributes region-attributed benchmark
  data, and a shared agent stays ineligible for region-pooled jobs until
  trusted.
- Region is a **runtime property** for non-public agents: network changes are
  re-detected (with hysteresis), and every job snapshots the siteId + trust at
  claim time so history never rewrites.

## Current state (what this changes)

| Piece | Today | After |
|---|---|---|
| `eval_agent_tokens.region` / `site_id` | NOT NULL, stamped at mint for **every** tier (`POST /api/eval-agent-tokens` requires `regionLocationBaseId`) | Nullable. Stamped at mint **only** for `public` tokens; non-public mints reject a supplied region |
| `eval_agents.site_id` | NOT NULL, copied from the token at registration | Nullable. Public: copied from token. Non-public: allocated by Vox after detection, NULL until location-eligible |
| Region source of truth at claim | Token (`claimEvalJob` matches `token.region` / stamps `token.siteId`) | Public: token. Non-public: **agent** (detected `region`/`siteId`), plus a trust gate for pooled claims |
| `observed_ip` | Recorded fire-and-forget, consumed by nothing | Input to the detection pipeline at register + heartbeat |
| Region catalog | Admin-configured only | Admin rows plus system-created `source='detected'` rows grown from observation |
| UI region tree | One catalog tree for all tabs | Mainline: fixed `is_mainline` rows. Community / My Evals: dynamic (cities with data). My Evals adds an **Unverified** node |

The eval-agent daemon never sends a region today (it registers with
`name`/`metadata` only), so **no daemon changes are required** — this ships
entirely server-side + console.

## Trust model

New enum-like status `location_trust` (varchar(16), values enforced in code):

| Status | Meaning | Region-eligible? |
|---|---|---|
| `trusted` | City-level GeoIP with tight accuracy radius, no anonymizer signal, non-hosting ASN | Yes |
| `datacenter` | Hosting ASN (AWS/GCP/…), no anonymizer signal. A cloud VM in Mumbai *is* in Mumbai; the label is carried for the future residential-vs-datacenter instinct | Yes |
| `anonymized` | Tor exit node, or ASN on the known-VPN/proxy list. The egress point is not where the machine is | No |
| `low_confidence` | GeoIP resolved but no city, or accuracy radius > 100 km | No |
| `unknown` | No usable public IP (private/loopback/CGNAT — local dev lands here), or GeoIP databases unavailable | No |

"Region-eligible" = may hold a `region`/`siteId` and contribute
region-attributed data. Everything else displays as **Unverified**.

**Accepted gap (v1):** a daemon in Seattle proxying its traffic through a
clean Mumbai VPS is invisible to GeoIP. The countermeasure is active RTT
probing (the network-instinct layer `observed_ip` was reserved for) —
explicitly out of scope here.

## Detection pipeline (`server/location.ts`, new)

Pure function core + two loaded data sources, so the ladder is unit-testable
with mock readers.

**Data sources:**
- **GeoLite2-City.mmdb + GeoLite2-ASN.mmdb** via the `maxmind` npm package
  (pure-JS mmdb reader, no native deps). Loaded from `GEOIP_DB_DIR` (default
  `<repo>/geoip/`, gitignored). Refreshed by a new `scripts/geoip-refresh.sh`
  using `MAXMIND_LICENSE_KEY` (MaxMind free GeoLite2 account) — run weekly
  (ops: Coolify scheduled command / cron). **Missing DBs are graceful:** every
  lookup returns `unknown`, so local dev needs no MaxMind account.
  The MaxMind key is a free-signup artifact, never a payment; when it is
  unset the refresh script falls back to **DB-IP Lite** (CC-BY-4.0,
  keyless download, same MMDB format, saved under the server's expected
  filenames) — slightly less accurate and without `accuracy_radius`,
  which the ladder tolerates (an absent radius is not a low-confidence
  trigger). GeoLite2 stays the recommended primary. CC-BY-4.0 requires
  visible credit: the refresh script writes a `geoip/ATTRIBUTION` marker
  on the DB-IP path (removed on the MaxMind path), the server surfaces it
  via `/api/config → geoipAttribution`, and the public footer renders
  "This product includes IP geolocation data created by DB-IP, available
  from https://db-ip.com" whenever DB-IP data is loaded.
- **Anonymizer signals (free tier, per ruling):**
  - Tor exit list fetched from `check.torproject.org/torbulkexitlist` at
    startup and every 12 h, held in memory; fetch failure keeps the previous
    list and logs once.
  - `server/data/asn-classification.json` — a checked-in map
    `{ "<asn>": "vpn" | "hosting" }` compiled from public lists (X4BNet
    lists_vpn, ipcat); `geoip-refresh.sh` regenerates it.

**Trust ladder** (first match wins):

1. IP is private / loopback / link-local / CGNAT (100.64/10) → `unknown`
2. Tor exit, or ASN classified `vpn` → `anonymized`
3. GeoIP miss, no city, or `accuracy_radius` > 100 km → `low_confidence`
4. ASN classified `hosting` → `datacenter`
5. otherwise → `trusted`

**Output:** `{ trust, regionBaseId | null, city, countryCode, lat, lon,
accuracyKm, asn, asnOrg }`. `regionBaseId` is non-null only for
region-eligible trust.

**City → catalog region resolution** (only for eligible results), in order:

1. **Nearest active catalog row within 100 km** of the GeoIP coordinates
   (needs `latitude`/`longitude` on `region_locations`; the five seeded rows
   are backfilled in the migration). This absorbs metro jitter — a Sunnyvale
   IP maps to the existing Santa Clara row instead of minting a duplicate —
   and keeps legacy baseIds like `apac-sg` working without matching the
   naming formula.
2. **Auto-create** a catalog row: `baseId = <macro>-<cc>-<cityslug>` (e.g.
   `na-us-santaclara`; slug = lowercase, ASCII-folded, alphanumeric only),
   `source = 'detected'`, `is_mainline = false`, lat/lon from GeoIP, macro
   from a fixed continent map (NA→`na`, SA→`sa`, EU→`eu`, AS/OC→`apac`,
   AF→`af`/"Africa"; Antarctica → treat as `low_confidence`). Admins can
   rename/merge detected rows later; the row is a normal catalog citizen
   (siteId sequence, dispatch pooling, UI tree).

City is the smallest region unit — unchanged; `region_locations` rows *are*
cities.

## Registration & heartbeat flow

**Register (`POST /api/eval-agent/register`):**
- Public-tier token: unchanged — agent gets the token's configured siteId.
  Detection still runs and is stored on the agent (observability only, no
  gating; admins deployed it, admins are trusted).
- Non-public token: after the agent upsert, run detection **synchronously**
  (local mmdb lookup, sub-millisecond). If region-eligible: assign
  `agent.region` and allocate a `siteId` from that region's sequence (same
  allocator the token mint uses today, factored into
  `storage.allocateSiteId(baseId)`). Registration is a fresh process, so a
  changed location applies immediately here — no hysteresis at register. If
  not eligible: `region`/`siteId` stay NULL, trust stored; the agent
  registers fine and can still serve its owner.

**Heartbeat (`POST /api/eval-agent/heartbeat`):** re-detect when the observed
IP changed, **or** `location_checked_at` is NULL or older than 24 h (this
staleness rule is what re-evaluates migrated agents and picks up GeoIP DB
refreshes without any IP change). Then:

- **Distrust fast:** a trust *drop* (eligible → not eligible) applies
  immediately — `region`/`siteId` cleared, fail closed.
- **Trust slow (hysteresis, per ruling):** a *region change* (or an upgrade
  from Unverified) requires the same new observation on **3 consecutive
  re-detections** before it applies (`pending_region` +
  `pending_region_count` on the agent row; any differing observation resets
  the pending state). While a pending region exists, **every** heartbeat
  re-detects (the IP-changed/staleness trigger alone would stall the counter,
  since the stored `observed_ip` updates each beat) — so at a normal
  heartbeat cadence the change settles in a few minutes, not days. On apply:
  allocate a fresh siteId in the new region;
  the old siteId is simply retired (sequences are never reused). A flapping
  network cannot churn agent identity.

Mid-job region changes are harmless: the job snapshotted its siteId/trust at
claim (below).

## Dispatch gating & claim-time snapshot

`claimEvalJob` / `getClaimableJobsForToken` currently parameterize on the
**token's** region/siteId. They change to an **effective identity**:

- `public` token → token's configured `region`/`siteId` (as today).
- non-public token → the claiming **agent's** detected `region`/`siteId`
  (both possibly NULL).

Predicate changes:

- **Pooled claims** (`target_region` set): effective region must match, which
  a NULL region never does — an Unverified agent structurally cannot claim
  any region-pooled job, of any tier. This is the shared-agent gate the
  ruling requires, and it applies to private/team pools too (a region pool is
  a region-attributed promise regardless of tier).
- **Targeted claims** (`target_token_id`): no trust gate — the dispatcher
  chose this specific agent knowingly. This is how an Unverified private/team
  agent still runs its owner's evals.
- **Legacy site-pinned claims**: match against the effective siteId.

The atomic claim update — which already freezes `token_dispatch_tier` and
stamps `site_id = COALESCE(site_id, …)` — additionally freezes
`location_trust` onto the job. A targeted job claimed by an Unverified agent
gets `site_id = NULL` + its trust value; its results carry no region.
Completed history is immutable, per the ruling.

**Marketplace listing consequence:** `setListing(...)` currently passes
`region: evalAgentToken.siteId`, which is NULL for shared tokens after this
change. The listing's region becomes nullable and is refreshed via the
marketplace seam when the agent's region is assigned or cleared
(`marketplace.updateListingRegion(tokenId, region | null)` — no-op stub when
the plugin is absent). Pooled shared dispatch is still disabled in Core
today, so this is forward-wiring, not a behavior change.

## Metrics classification & the Unverified bucket

- `eval_results.site_id` becomes nullable; NULL = ran without a verified
  region. Region-scoped queries (`regionScopeCondition`, LIKE on baseId)
  already exclude NULLs naturally.
- **Community gate hardening** (`communityConditions`): add
  `token_dispatch_tier = 'public' OR location_trust IS NULL OR location_trust IN ('trusted','datacenter')`.
  The `IS NULL` arm grandfathers pre-feature rows — history does not
  reclassify. (Mainline needs no change: it is public-agents-only, and public
  agents are configured/trusted.)
- **My Evals**: `RegionQueryScope` gains `unverified?: boolean` →
  `site_id IS NULL` filter, so the owner's Unverified results are reachable.
- All three metrics responses gain `availableRegions: string[]` — the
  distinct region baseIds with data for that tier + window, computed
  **without** the request's region scope (the tree must show what exists, not
  what's currently selected). My Evals additionally returns
  `hasUnverified: boolean`.

## UI

**Region tree (`region-scope-selector.tsx` + `realtime.tsx`):**
- **Mainline tab:** tree shows exactly the catalog rows with
  `is_mainline = true` (the current five cities; admin-managed via the
  existing region-locations admin CRUD, which gains the flag). A mainline
  city with no data in the window renders as an empty/no-data state — it
  never vanishes; the gap is the signal.
- **Community / My Evals tabs:** tree shows the catalog rows in that
  response's `availableRegions` — dynamic, cities that actually have data.
  Same macro → country → city hierarchy and component; only the row filter
  differs per tab.
- **My Evals only:** an **Unverified** pseudo-node (outside the geographic
  hierarchy) toggling the `unverified` scope.

**Run dialog — agent picker (task creation):**
When running an eval set against agents (creating a job), the available
agents are presented as a **two-level region tree**: region nodes with the
concrete siteIds of available agents as leaves — the same macro → country →
city hierarchy as the metrics tree, showing only regions/sites that have a
dispatchable agent.

- **Public agents: region-only.** The user picks a region node; the request
  dispatches to the pool (`region + targetTier: public`). Individual public
  siteIds are visible as informational leaves but not selectable — pinning a
  specific public agent is not offered.
- **Private / team / shared agents: region or siteId.** The user may pick a
  region node (pool dispatch, `region + targetTier`) or a specific siteId
  leaf (targeted dispatch — the wire contract stays `targetTokenId`; the
  leaf maps to the token behind the agent occupying that site, the siteId is
  just how it is presented).
- **Unverified agents have no siteId**, so they cannot appear under any
  region node. Private/team Unverified agents remain targetable (targeted
  dispatch is trust-exempt) and are listed under an **Unverified** group at
  the bottom of the picker. Shared Unverified agents are not dispatchable at
  all and do not appear.

This replaces the current flat Region-select + tier-select + "any/specific
agent" dropdown in the run dialog: one tree answers both "where" (region
pool) and "which" (exact site), and the selectable set is derived from the
same effective-identity rules the claim path enforces — the UI never offers
a dispatch the server would refuse.

**Console:**
- Token mint dialog: the region picker renders **only when tier = public**
  (admin). For private/team/shared it is replaced by static text: "Region:
  detected automatically when the agent connects." The server enforces the
  same rule (below), the UI just stops offering what would 400.
- Tokens list: `siteId` column shows the agent's detected siteId or an
  "auto" placeholder for non-public tokens.
- Agents list (console + public `/api/eval-agents`): show detected
  region/city plus a trust badge — `Verified` (trusted), `Verified ·
  datacenter`, or `Unverified`. The coarse `location_trust` value is exposed;
  the raw IP, coordinates, and ASN never are (`location_source` stays
  Core-internal, same rule as `observed_ip`).

## API surface changes

- `POST /api/eval-agent-tokens` and `POST /api/admin/eval-agent-tokens`:
  `regionLocationBaseId` is **required for `public`** tier and **rejected
  (400) for any other tier** — strip-then-reject, so a caller-supplied region
  on a non-public mint is never silently honored (same philosophy as
  `sessionInjection` strip-then-stamp).
- `GET /api/eval-agents`, `GET /api/eval-agent-tokens`: add
  `region`/`locationTrust` (agents) and nullable `siteId` (tokens).
- Metrics endpoints: `availableRegions` (+ `hasUnverified`, `unverified`
  scope on my-evals) as above.
- Admin region-locations CRUD: `isMainline`, `latitude`, `longitude`
  editable; `source` read-only.

## Schema & migration (0035, registered in `server/migrate.ts`)

```sql
-- region_locations: geometry + curation
ALTER TABLE region_locations ADD COLUMN latitude double precision;
ALTER TABLE region_locations ADD COLUMN longitude double precision;
ALTER TABLE region_locations ADD COLUMN source varchar(16) NOT NULL DEFAULT 'configured';
ALTER TABLE region_locations ADD COLUMN is_mainline boolean NOT NULL DEFAULT false;
UPDATE region_locations SET is_mainline = true, latitude = 47.6062,  longitude = -122.3321 WHERE base_id = 'na-us-seattle';
UPDATE region_locations SET is_mainline = true, latitude = 1.3521,   longitude = 103.8198  WHERE base_id = 'apac-sg';
UPDATE region_locations SET is_mainline = true, latitude = 19.0760,  longitude = 72.8777   WHERE base_id = 'apac-in-mumbai';
UPDATE region_locations SET is_mainline = true, latitude = 50.1109,  longitude = 8.6821    WHERE base_id = 'eu-de-frankfurt';
UPDATE region_locations SET is_mainline = true, latitude = -23.5505, longitude = -46.6333  WHERE base_id = 'sa-br-saopaulo';

-- tokens: region is public-tier-only now
ALTER TABLE eval_agent_tokens ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE eval_agent_tokens ALTER COLUMN region  DROP NOT NULL;
UPDATE eval_agent_tokens SET site_id = NULL, region = NULL WHERE dispatch_tier <> 'public';

-- agents: detected location state
ALTER TABLE eval_agents ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE eval_agents ADD COLUMN region varchar(64);
ALTER TABLE eval_agents ADD COLUMN location_trust varchar(16) NOT NULL DEFAULT 'unknown';
ALTER TABLE eval_agents ADD COLUMN location_checked_at timestamp;
ALTER TABLE eval_agents ADD COLUMN location_source jsonb;
ALTER TABLE eval_agents ADD COLUMN pending_region varchar(64);
ALTER TABLE eval_agents ADD COLUMN pending_region_count integer NOT NULL DEFAULT 0;
UPDATE eval_agents SET site_id = NULL
  WHERE token_id IN (SELECT id FROM eval_agent_tokens WHERE dispatch_tier <> 'public');

-- claim-time snapshot + unverified results
ALTER TABLE eval_jobs ADD COLUMN location_trust varchar(16);
ALTER TABLE eval_results ALTER COLUMN site_id DROP NOT NULL;
```

Per the migration ruling: existing non-public agents lose their minted
region/siteId and are `unknown` until their next register or (staleness-rule)
heartbeat re-detects them. Existing **jobs and results keep their site_id** —
history is immutable. Public tokens/agents are untouched.

## Deployment invariants (load-bearing once trust derives from IP)

1. **Proxy hop count stays exactly 1.** `trust proxy, 1`
   (`server/index.ts:53`) is correct for Coolify's Traefik. Adding a
   CDN/extra proxy in front silently turns `req.ip` into the edge's IP —
   revisit the trust-proxy depth with any topology change.
2. **The Node port is never directly reachable in production.** A direct
   connection under `trust proxy, 1` lets the client's own
   `X-Forwarded-For` be believed — exactly the self-assertion this design
   forbids. Coolify's default (only Traefik published) must stay.
3. **Runtime tripwire:** in production, an observed private/RFC1918 IP on
   register/heartbeat scores `unknown` and logs one warning ("proxy hop
   count likely misconfigured") — the signature of a broken invariant, made
   visible instead of silently geolocating nothing.

## Non-goals

- **RTT / active probing** — the real answer to proxy-through-a-clean-VPS;
  future network-instinct layer on `observed_ip`.
- **Paid anonymizer databases** (MaxMind Anonymous IP, IPinfo Privacy) —
  free-tier signals first, per ruling; the ladder is a seam a better source
  can slot into.
- **Admin override of a detected agent location** — zero-trust stays pure;
  admins curate the catalog (rename/merge detected rows), not agent
  locations.
- **Relabeling any historical result.**
- **Changing schedule/run-route region *targeting*** — picking which region
  pool to dispatch INTO is demand, not an assertion of agent location.

## Testing

- **Unit:** trust ladder (each rung, mocked mmdb/Tor/ASN readers); baseId
  derivation + slugging; nearest-catalog-within-100km vs auto-create;
  hysteresis state machine (3-stable applies, reset on differing
  observation, immediate trust-drop); mint-route region rejection per tier;
  private-IP → unknown tripwire.
- **Integration (DB):** claim predicate — Unverified agent cannot claim any
  pooled job, can claim targeted; claim freezes `location_trust` + NULL
  `site_id` for Unverified; community grandfather clause; `availableRegions`
  ignores request scope; migration against a polluted dev DB.
- **E2E:** token mint dialog hides region picker for non-public; agents page
  trust badges; My Evals Unverified node.
- Graceful-degradation test: no GeoIP DBs on disk → everything registers,
  everything is `unknown`, nothing crashes (this is the local-dev path, so
  the existing suites exercise it implicitly — plus one explicit assertion).

## Rollout

1. Merge + deploy (migration auto-runs). All non-public agents show
   Unverified until their next heartbeat staleness re-check (≤ 24 h) or
   restart.
2. Ops: create MaxMind account, set `MAXMIND_LICENSE_KEY`, run
   `scripts/geoip-refresh.sh`, schedule it weekly. Until then, production
   agents stay `unknown`/Unverified — safe-by-default, visible, and a
   one-command fix.
3. Admin sanity pass on the Brokers/Agents page: confirm the public fleet's
   detected locations look right (observability from day one, gating only
   where designed).
