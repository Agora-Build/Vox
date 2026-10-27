# Network Tags — Part 2 Implementation Plan (access, system-only sim, badge, region grouping)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the system-only `access` (lastmile/datacenter/unknown) and `sim` tags, derive location trust's `datacenter` from access, show access on the agent badge, and let every metrics view group by region.

**Architecture:** One classifier in the existing location pipeline (`server/location.ts`) computes region + trust + access from Core-side signals (datacenter IP ranges, PeeringDB types, APNIC end-user estimates, mobile-carrier ASNs, reverse DNS) plus agent signals that may only push away from last mile. Results are stored on the agent (system-only columns) and frozen at claim by `buildJobTags` as `detected` tags. `sim` = Twilio lookup of our SIM's number matched by MCC-MNC against the SIM operator DialF reports.

**Tech Stack:** TypeScript, Express, Drizzle/PostgreSQL (hand-written migrations), React + TanStack Query, Vitest, Playwright.

**Spec:** `designs/2026-10-22-network-tags-design.md` — sections "Last mile vs datacenter (`access`)", "`sim` is system-only", "Agent badge follows `access`", "Group by region". Part 1 (`designs/2026-10-22-network-tags-plan.md`) is built on this branch.

## Global Constraints

- `access` values: `lastmile` | `datacenter` | `unknown`. `sim` values: carrier slug (e.g. `t-mobile`). Both are **system-only**: refused on flows AND agents at save (400), absent from the tag editor, never writable by any route.
- Decision rule (verbatim from spec): 1. Tor/VPN → unknown. 2. Any datacenter signal (datacenter range, hosting ASN, PeeringDB Content/Hosting, server-style rDNS, cloud metadata) → datacenter. 3. No datacenter signal, agent reports nothing contrary (no public IP on the interface), and either a mobile-carrier ASN or two independent Core signals (access network by APNIC or PeeringDB Cable/DSL/ISP **and** residential rDNS) → lastmile. 4. Otherwise unknown.
- Only Core signals can earn `lastmile`; agent signals can only push to `datacenter` (cloud metadata) or `unknown` (public IP on interface). Disagreement → unknown. Missing data → fewer signals → more unknown, never a wrong lastmile.
- Reason string frozen with the job carries a classifier version + deciding signals, e.g. `v1: mobile-asn`, `v1: eyeball-asn + residential-rdns`, `v1: dc-range`.
- Location trust's `datacenter` value is derived from `access = datacenter` (replacing the 12-ASN `hosting` check); `trusted`/`datacenter` gating is unchanged (`REGION_ELIGIBLE_TRUST`, Community gate).
- Access is computed for every agent, including public ones. Analyze jobs still freeze `[]`. `sim` is frozen on phone jobs only.
- Next migration: version 59, file `0058_access_sim.sql` (0057 is v58, part 1). Plain SQL, registered in `server/migrate.ts`.
- Data downloads follow `server/geoip-refresh.ts` (in-app weekly refresh, stored under `GEOIP_DB_DIR`, atomic replace, startup when missing/stale). Each source's licence/terms recorded in `docs/DEPLOYMENT.md` and credited in the footer like DB-IP if required. No source → that signal is simply absent.
- `observed_ip` and our full SIM number are never exposed; our number stored redacted (last 4) on the agent.
- No fake functionality; stubs only inside tests; every rule gets a test that fails when removed (mutation-check). Integration tests: restart dev after `server/` changes; `DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox"`.
- Commits end with `🤖 Built with SMT <smt@agora.build>`.

---

### Task 1: Access data sources + refresh

**Files:** Create `server/access-data.ts`; modify `server/geoip-refresh.ts` (or a sibling `server/access-data-refresh.ts` using the same helpers); `server/data/mobile-carrier-asns.json` (curated seed: T-Mobile US 21928, Verizon Wireless 6167/22394, AT&T Mobility 20057, plus major non-US carriers with sources noted); tests `tests/access-data.test.ts`.

**Produces:** `loadAccessData()` / in-memory `AccessData { isDatacenterIp(ip): boolean; isVpnIp(ip): boolean; peeringdbType(asn): "access" | "content" | "enterprise" | "other" | undefined; eyeballShare(asn): number | undefined; isMobileAsn(asn): boolean }`, refreshed weekly; parsers for each source tested on small fixture files under `tests/fixtures/access/`.

- Sources: datacenter ranges (X4BNet `lists_vpn` datacenter ipv4/ipv6 lists; ipcat if licence allows), VPN ranges (X4BNet vpn list), PeeringDB bulk `net` export (info_type), APNIC per-ASN end-user estimates. Verify each licence first; if one isn't usable, leave it out and say so in the report.
- Range lookup must be efficient (sorted ranges + binary search, or `net.BlockList`); measure lookup time in a test with ≥100k ranges.
- `asn-classification.json` stays as a seed used until the first successful download.

### Task 2: Classifier in the location pipeline + storage

**Files:** Create `server/access-class.ts` (pure `classifyAccess(signals) → { access, reason }`, `ACCESS_CLASSIFIER_VERSION = "v1"`, rDNS residential/server pattern lists); modify `server/location.ts` (`detectLocation` computes access in the same pass, does the reverse-DNS lookup with a short timeout, derives trust `datacenter` from access); `shared/schema.ts` + `migrations/0058_access_sim.sql` + `server/migrate.ts` (`eval_agents.access_class varchar(16)`, `access_reason text`, `access_checked_at timestamp`, `sim_carrier varchar(48)`, `sim_reason text`, `sim_number_redacted varchar(8)`; `number_lookups.mcc varchar(3)`, `mnc varchar(3)`); wherever the location result is persisted on register/heartbeat; tests `tests/access-class.test.ts` (rule table incl. "agent can never earn lastmile", "disagreement → unknown", AT&T colo → unknown, mobile ASN alone → lastmile, missing data → unknown) and an integration test that register/heartbeat store access and that trust becomes `datacenter` from a datacenter range.

### Task 3: Agent network signals

**Files:** Create `vox_eval_agentd/net-signals.ts` (`cloudMetadata`: GET `http://169.254.169.254/` and `http://metadata.google.internal/` with ≤500 ms timeout, cached 10 min; `publicIpOnInterface`: default-route interface holds a public address — `VOX_PUBLIC_IP_ON_IFACE` env wins); modify `vox-agentd.ts` (send `netSignals` on register/heartbeat, omit unknown fields); `scripts/vox-upgrade.sh` (host check → `-e VOX_PUBLIC_IP_ON_IFACE=true|false`); Core routes accept `netSignals` and feed them to the classifier (Task 2's signals input); Dockerfile COPY if needed + real docker build; tests `tests/net-signals.test.ts`, daemon wire test, vox-upgrade test, Core integration (cloudMetadata → datacenter; publicIpOnInterface → lastmile becomes unknown; agent can't upgrade unknown → lastmile).

### Task 4: System-only sim + reserved keys + claim freezing

**Files:** `shared/tags.ts` (`access`, `sim` system-only keys: refused for both ends with a clear message; agent end keys become `isp`, `link` + custom; TagInput follows); `server/number-lookup.ts` (store MCC/MNC from Twilio `line_type_intelligence.mobile_country_code`/`mobile_network_code`; a `lookupNumber(e164)` reusable by sim); new `server/sim-carrier.ts` (agent reports `sim: { number, mcc, mnc, operatorName }` on register/heartbeat — DialF fields when available; Core looks up the number, compares MCC-MNC → `sim_carrier` + reason, or null with reason "mismatch"/"no operator from phone"/"lookup off"); `vox_eval_agentd` (read SIM operator name + MCC/MNC from DialF `sims.list` if present — fields `operator`, `mcc`, `mnc`; absent today → omit); `server/job-tags.ts` (freeze `access:<class>` detected on all non-analyze jobs; `sim:<carrier>` detected on phone jobs only; reasons frozen alongside — extend JobTag with optional `reason`); `effectiveTags`/`server/tag-sql.ts`: `access` and `sim` use detected on every board (consistency test extended); tests for each rule incl. MVNO match by code, mismatch → no tag, reserved-key refusal on both ends, freezing.

### Task 5: Analysis + UI

**Files:** `server/metrics-params.ts`, `server/storage.ts`, `server/routes.ts`, `server/routes-api-v1.ts`: `groupBy=region` (reserved groupBy key; group value = the site's location base, or `recording_region` for analyses, else `unattributed`), console + v1, cache keys; leaderboard rows add per-access columns (last-mile and datacenter averages per provider × site) when no access filter is set; `docs/openapi.yaml`. Client: All / Last mile / Datacenter toggle (default All) mapping to `tag=access:…`; "Region" in Group by; Leaderboard last-mile / datacenter columns; Agents page badge — `Verified · last mile` / `Verified · datacenter` / `Verified` / `Unverified` — from `access_class` + location trust, with access reason in a tooltip; agent rows expose `accessClass`, `accessReason` (never IP). Tests: integration for groupBy=region and access columns; e2e toggle + badge. Screenshots of each changed page.

### Task 6: Docs + DialF request text

**Files:** `CLAUDE.md` (access/sim/region-grouping/one-pipeline paragraph), `docs/DEPLOYMENT.md` (data sources + licences, `VOX_PUBLIC_IP_ON_IFACE`, migration v59, residential-proxy limit), `client/src/pages/api-docs.tsx` + `README.md` (access tag, groupBy=region), and `designs/dialf-sim-operator-request.md` (the request text for DialF: `sims.list` to return operator name + MCC + MNC per SIM).
