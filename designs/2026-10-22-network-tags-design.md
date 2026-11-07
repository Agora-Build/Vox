# Network tags: design and implementation

**Status:** implemented on PR #258, pending merge. Approved 2026-10-22;
consolidated with the implementation plans and review fixes on 2026-11-04.

This is the single source of truth for network tags, access classification,
SIM matching, implementation boundaries, and the DialF SIM-operator contract.
The two original implementation plans and separate DialF request are folded
into this document; superseded proposals are not rollout instructions.

## Contents

- [Tag format](#tag-format-sharedtagsts) and [data model](#data-model)
- [Detection](#detection) and [number lookup](#number-lookup-line)
- [Freezing at claim](#freezing-at-claim) and [board rules](#which-value-a-board-uses)
- [API contracts and permissions](#api-contracts-and-permissions)
- [Analysis](#analysis), [rollout](#rollout), and [testing](#testing)
- [Last mile vs datacenter](#last-mile-vs-datacenter-access)
- [System-only SIM matching](#sim-is-system-only--detected-on-both-sides-must-match)
- [DialF SIM-operator contract](#dialf-sim-operator-contract)
- [Agent badges](#agent-badge-follows-access) and [region grouping](#group-by-region)
- [Implementation map](#implementation-map) and [migration history](#migration-history)

## What and why

A result records **which provider**, **which region** and **web or phone**.
Network tags add **which network path** the conversation took — and that can
matter as much as the provider. The same voice agent behind a Twilio number and
behind a Bandwidth number can answer at different latency; the same eval run
from a Starlink-on-WiFi host and an AT&T-fibre host can measure differently.

**Tags** record that path on every result, so the boards can be filtered and
split by it: "ElevenLabs × Twilio vs ElevenLabs × Bandwidth", "only results
measured over Ethernet", "Starlink vs everything else".

## Decisions (made in discussion)

| Question | Decision |
|---|---|
| Phone line provider — lookup or manual? | **Automatic lookup**, with manual tags as the fallback and the override. |
| Which lookup service? | **Twilio Lookup v2, Line Type Intelligence** (~$0.008/lookup, self-service, worldwide; returns `carrier_name` and line type). Behind a small seam so a second service (e.g. Telnyx) can be added later. |
| How free are tags? | **Known keys + custom keys.** Known: `line`, `isp`, `link`, `access`, `sim`; `access` and `sim` are system-only. Custom keys allowed (`codec:opus`, `vpn:on`), filterable, no suggestions. |
| Detected vs hand-set — which counts? | **Both kept.** The agent's operator may correct a detected tag. My Evals and Community use the hand-set value; **Mainline uses the detected value** for `isp`/`link` (a public agent's operator could otherwise mislabel results others rely on). |
| Where does analysis show in v1? | **Filter + Group by on the existing views** (Leaderboard, Community, My Evals) and the same parameters on the public API. A comparison page is v2. |
| Where are tags stored? | Hand-set `tags` on the flow and agent, cached line lookup on the flow, and reported link/system classifications on the agent. Claim assembles and freezes the source-labelled job tags; ISP detection happens at claim. |
| Public visibility of user-run agents? | Keep coarse ISP and connection-type tags visible in Community and the public API, including results from private-token agents running public flows. Do not expose raw IPs, user account identity, or addresses through tags. |

## Two ends of every result

| End | Tags | Who knows | Detected? |
|---|---|---|---|
| **Target** — the agent under test | `line` (Twilio, Bandwidth, Telnyx, Vonage, Plivo…), custom | the eval flow's owner | `line` by number lookup (below), when configured |
| **Vantage point** — our eval agent | `isp` (AT&T, Comcast, Starlink…), `link` (wifi / ethernet / cellular / satellite), custom; system-only `sim` (our SIM's carrier) and `access` | the agent's host | `isp`, `link` yes (correctable); `sim`, `access` system-only — see below |

A flow runs on many agents, so vantage tags can't live on the flow; the line
provider describes the target, so it can't live on the agent.

## Tag format (`shared/tags.ts`)

- A tag is `key:value`. Both parts are trimmed and lowercased; inner whitespace
  becomes `-`. `Twilio`, ` twilio ` and `TWILIO` are one value.
- **Key:** `[a-z][a-z0-9-]{0,23}`. **Value:** `[a-z0-9][a-z0-9.\-]{0,47}`.
- At most **16 tags** per flow / agent; one value per key (a second `line:` replaces the first).
- **Known keys:**
  - `line` — suggestions: twilio, bandwidth, telnyx, vonage, plivo, sinch, signalwire.
  - `isp` — suggestions from the ASN map below.
  - `link` — **closed set**: `wifi | ethernet | cellular | satellite`; anything else is refused.
  - `access` — system-only, closed set: `lastmile | datacenter | unknown`.
  - `sim` — system-only carrier slug, such as `att`, `verizon`, or `t-mobile`.
- Flow editors may set `line` and custom keys; agent operators may set `isp`,
  `link`, and custom keys. `access`, `sim`, and `region` cannot be hand-set.
  `untagged` is a reserved value for missing tag groups, not a writable value.
- One module, imported by the client form, Core's save routes and the agent, so
  they can't disagree (the `shared/placeholders.ts` pattern). Client-safe: no
  dependencies.

## Data model

| Table | Column | Content |
|---|---|---|
| `eval_flows` | `tags jsonb not null default '[]'` | hand-set by whoever can edit the flow (`isOwnerOrOrgManager`) |
| `eval_agents` | `tags jsonb not null default '[]'` | hand-set by the agent's operator (the token's owner) — a correction or an extra tag |
| `eval_flows` | `line_lookup jsonb` | the number lookup's answer for the flow's dialled number (value, carrier name, line type, time); null = not looked up |
| `number_lookups` | table | per-number cache: keyed hash of the E.164, provider, carrier name, line type, mapped value, looked-up time |
| `eval_agents` | `link_type varchar(16)` | reported by the agent on register/heartbeat; null = not reported (an older agent) |
| `eval_agents` | `access_class`, `access_reason`, `access_checked_at`, `access_ip` | system classification, versioned reason, check time, and internal checked-IP binding |
| `eval_agents` | `net_signals jsonb` | optional agent-reported cloud-metadata and public-interface-IP signals |
| `eval_agents` | `location_check_gen bigint not null default 0` | internal generation fencing asynchronous location/access checks across Core instances |
| `eval_agents` | `sim_carrier`, `sim_reason`, `sim_number_redacted`, `sim_number_hash`, `sim_report_gen` | system SIM match, last four digits, internal full-number HMAC, and race-protection generation |
| `eval_jobs` | `tags jsonb` | frozen at claim (below); null for jobs claimed before the release |
| `number_lookups` | `invalid_number`, `mcc`, `mnc` | definitive negative-cache flag and optional network codes, alongside the carrier answer |
| `paid_lookup_usage` | scope, subject, UTC day, count | durable paid-lookup allowances reserved atomically in PostgreSQL |

Hand-written migrations 0057-0064 are registered as schema versions 58-65 in
`server/migrate.ts`; see [migration history](#migration-history). No result-tag
backfill: older results are simply untagged. Existing access classifications are
not assigned a guessed IP binding; they are unknown at claim until rechecked.

Visibility: an agent's tags and link type are shown to whoever can see the
agent. Job tags also accompany publicly visible results, including coarse
`isp`/`link` from user-run agents. `observed_ip`, `access_ip`, and full SIM
numbers stay Core-internal and are never added to agent or result responses.

## Detection

- **`isp` — Core, free.** At claim, Core looks up the agent's `observed_ip` in the
  ASN database it already ships (`server/location.ts`, `AsnLookup { asn, org }`).
  A short map in `shared/tags.ts` turns common ASNs into clean values
  (14593 → `starlink`, 7018 → `att`, 7922 → `comcast`, 701 → `verizon`,
  21928 → `t-mobile`, 16509 → `aws`, 15169 → `gcp`, …); an unmapped ASN falls
  back to its org name, normalised. No ASN database / no IP → no detected `isp`.
- **`link` — the agent.** Linux: the interface of the default route (`ip route get 1.1.1.1`)
  → `/sys/class/net/<if>/wireless` = wifi, a `wwan*`/cdc/qmi interface = cellular,
  otherwise ethernet. macOS: `route get default` + `networksetup -listallhardwareports`.
  A container sees its own veth, not the host's NIC — `vox-manager.sh` passes the
  host's answer in (`VOX_LINK_TYPE`, detected on the host at upgrade time), and the
  daemon prefers it. Satellite can't be seen from an interface: it's inferred at
  claim from `isp:starlink` (or any satellite ASN in the map) unless `link` is set otherwise.
  Reported on every heartbeat like `capabilities`; an old agent reports nothing.
  **`link` is agent-reported, and Core files it as `detected` as received** — Core
  cannot check it. Mainline trusts it because Mainline agents (public-tier, admin-run)
  are run by us; a modified community agent could report any value, which is why
  My Evals and Community let the operator's hand-set value win anyway.
  Detection runs no shell: commands are argument arrays (`execFileSync`) and an
  interface name from the OS's own output is checked against
  `^[A-Za-z0-9._@:-]{1,32}$` (not `.`/`..`) before it is used anywhere — anything
  else reads as "couldn't tell". `vox-manager.sh` validates the same way.
- **`sim`** — system-only. Core matches the SIM's reported MCC/MNC against a
  lookup of its own number. Missing operator fields mean no SIM tag, not a
  manual fallback; see [SIM matching](#sim-is-system-only--detected-on-both-sides-must-match)
  and the [DialF contract](#dialf-sim-operator-contract).
- **`line`** — by number lookup (next section); hand-set on the flow as the fallback and the override.

## Number lookup (`line`)

The number is the **agent's** number — the one in the flow's `call.dial` Setup
step, which we dial to reach the voice agent under test. (Our own SIM is the
other end: the `sim` tag.)

- **Where:** Core, when a phone flow is saved and whenever its dialled number
  changes (`server/number-lookup.ts`). **The save never waits for it:** the save
  responds first, with the flow's current (possibly old or null) `lineLookup` plus
  `lineLookupPending: true`, and the lookup runs in the background through the same
  conditional write (errors logged by name only); the console shows "Looking up the
  line provider…" and refetches a few times. "Look up again" is an explicit action
  and still waits for the answer (up to the 10 s timeout). Results are cached per number for 30 days
  (`number_lookups`: keyed hash of the E.164 number — never the number itself —
  provider, carrier name, line type, mapped value, looked-up time) — about one paid lookup per number per month; a cached
  answer is reused across flows and owners.
- **Invalid-number answers:** a provider-reported invalid number (HTTP 404 or
  `valid: false`) is cached for the same 30 days, keyed only by the number's
  keyed hash. It is distinct from a valid number with no carrier. Cache hits
  consume no paid-lookup allowance; expiry permits a fresh check. Timeouts,
  rate limits, authentication errors and other provider failures are not cached.
  The UI says "The lookup provider reports this phone number as invalid."
  This is a provider validity result, not proof that every call would fail.
- **Which number:** a literal number in `call.dial`, or one filled from the
  flow's own `${config.*}`. **Never a number held in a secret** — sending a
  secret's value to a third party breaks the rule that secrets don't leave Vox;
  such flows stay manual, and the form says so.
- **Service:** Twilio Lookup v2 `GET /v2/PhoneNumbers/{n}?Fields=line_type_intelligence`
  → `carrier_name`, `type`. A `NumberLookupProvider` interface (one
  implementation) keeps a second service additive. Toll-free and other types
  Twilio returns no carrier for stay untagged (manual).
- **Mapping:** `carrier_name` → a known value through a map in `shared/tags.ts`
  ("Twilio - SMS/MMS-SVR" → `twilio`, "Bandwidth.com CLEC" / "Bandwidth/13" →
  `bandwidth`, "Telnyx" → `telnyx`, "Vonage"/"Nexmo" → `vonage`, …); unmapped
  names fall back to the name, normalised. The line type (`nonFixedVoip`,
  `mobile`, …) is kept on the lookup row for display, not as a tag in v1.
- **Stored on the flow** in separate `eval_flows.line_lookup jsonb` (value,
  carrier name, line type, time), so the owner's hand-set `tags` stay theirs.
  Claim freezes a successful value as `line` with source `detected`; the owner
  may still set a separate `line` tag by hand.
- **Configuration:** an admin enters the Twilio Account SID + Auth Token on the
  admin Regions page, like the MaxMind key, stored encrypted in
  `systemConfig`. No credentials → lookup is off, `line` is manual only, the form
  says why. A failed lookup (network, 4xx) never blocks saving the flow; it's
  retried on the next save or by a "Look up again" button.
- **Disclosure:** the flow form notes that the dialled number is checked with
  Twilio Lookup to identify its line provider.
- **Concurrency and spending:** concurrent misses for the same number are
  single-flighted. A flow lookup writes only if a locked re-read confirms the
  flow still dials the same full number; equality uses its keyed HMAC, never
  only its last four digits. Errors or save-time races cannot overwrite a newer
  number's answer. Durable caps, reserved flow/SIM shares, and billable-response
  accounting are detailed under [SIM matching](#sim-is-system-only--detected-on-both-sides-must-match).
  The hash uses `CREDENTIAL_ENCRYPTION_KEY` or `SESSION_SECRET`; without a server
  key, nothing is cached. Plain numbers are never cache keys.

## Freezing at claim

The shared `claimEvalJob` path freezes per-job facts (`token_dispatch_tier`,
`location_trust`). In the same claim UPDATE, Core writes `eval_jobs.tags`:

```json
[
  { "key": "line", "value": "twilio",   "source": "flow" },
  { "key": "isp",  "value": "starlink", "source": "detected" },
  { "key": "isp",  "value": "att",      "source": "agent" },
  { "key": "link", "value": "wifi",     "source": "detected" }
]
```

Sources: `flow` (the flow's hand-set tags), `agent` (the agent's hand-set
tags), `detected` (`isp` from the IP, `link` from the heartbeat or inferred,
`line` from the number lookup). A key may
appear twice — detected and hand-set — so a board's rule can change later
without rewriting history. The snapshot keeps its own copy of the flow's tags
too (as for every flow field), so editing a flow's tags never changes past jobs.
`JobTag` also accepts an optional versioned `reason` for system classifications.
Analyze jobs freeze `[]`; `line` lookup and `sim` tags apply only to phone jobs,
using the job's stamped transport rather than a later edit of the live flow.

## Which value a board uses

For each key, the effective value of a job is:

| Board | Rule |
|---|---|
| **Mainline** | `line`/`isp`/`link`/`sim`: the **detected** value (lookup / IP / heartbeat); a hand-set-only value counts as untagged — except `line` on a flow without lookup (no credentials, toll-free, secret number), where the flow owner's value counts, as the flow is the owner's claim anyway. Other keys: the flow's / agent's value. |
| **Community, My Evals** | the **hand-set** value when there is one, else the detected one. |

`access` and `sim` always use detected values on every board. For a duplicate
custom key, the agent's hand-set value takes precedence over the flow's value.

One function (`effectiveTags(jobTags, board)` in `shared/tags.ts`) — the SQL
filter and the JS grouping both go through it (the SQL side as a generated
predicate on the jsonb array).

## API contracts and permissions

- Console and v1 flow create/update routes validate with
  `parseTags(raw, { end: "flow" })`; flow tags follow the existing
  owner/organization-manager edit permission. Invalid tags return 400.
- `PATCH /api/eval-agents/:id/tags` requires a session and the token creator's
  ownership. Admin status alone is not edit permission. Agent responses expose
  `canEditTags` so the UI offers editing only to that operator.
- Register/heartbeat accept optional `linkType`. Absent or unrecognized values
  leave it unchanged, a recognized value replaces it, and explicit `null` clears
  it. Optional `netSignals` and `sim` reports are validated independently; older
  agents need not send any of these fields.
- `POST /api/eval-flows/:id/line-lookup` requires flow-edit permission and performs
  the explicit "Look up again" action. Automatic save-time lookup remains
  asynchronous in both console and v1 routes.
- `GET/PUT/DELETE /api/admin/number-lookup/twilio` require both authentication
  and admin authorization. GET returns configuration status and a masked SID,
  never the Auth Token; credential updates are excluded from request logging.
- `shared/tags.ts` is the dependency-free client/server/daemon model. Keep
  `normalizeTag`, `parseTags`, `effectiveTags`, `parseTagFilter`, and
  `parseGroupBy` consistent with `server/tag-sql.ts` and `docs/openapi.yaml`.

## Analysis

**Parameters** — on the console metrics endpoints (`/api/metrics/realtime`,
`/leaderboard`, `/community`, `/my-evals`) and the public API
(`/api/v1/metrics/realtime`, `/leaderboard`):

- `tag=key:value` — repeatable, all must match (effective value, per the board's rule).
- `groupBy=key` — splits each provider × site row by that key's effective value.
  Results without it form an `untagged` group; nothing is dropped.

Bad tag / key syntax → 400 (the same parser as everywhere). Response rows carry
`tags` (effective); `meta` echoes `tag` and `groupBy`. Console caches add both to
the cache key. The keyless rate limit and the tier/transport rules are unchanged.

**Console UI**

- **Eval flow form:** a Tags field (chips; known keys suggest values; `line` is
  offered first when the flow's transport is phone). Phone flows show the
  lookup's answer ("Line provider: Bandwidth — looked up 2026-10-22, VoIP") with
  "Look up again", or why there's none (not configured / number is a secret /
  no carrier for toll-free).
- **Admin:** Twilio Lookup credentials (set / replace / remove), shown masked.
- **Agents page:** each agent shows its tags — detected ones marked "detected",
  hand-set ones editable by its operator; a hand-set value that overrides a
  detected one shows both.
- **Leaderboard, Community, My Evals:** a tag filter (chips) and a "Group by"
  select (known keys first, then custom keys seen in the data).
- **Result rows and job pages:** the job's tags, with source.

## Rollout

1. Deploy Core with all migrations through schema v65 (claim freezing,
   parameters, UI, number lookup, access binding, check generations, and SIM matching).
   Upgrade every Core instance: an older Core still uses IP-only write guards.
   The generation guard requires no agent upgrade or protocol change.
   Detected `isp` works at once for every agent — it needs only Core. Lookup
   turns on when an admin enters Twilio credentials; existing phone flows are
   looked up on their next save or "Look up again". Do not configure production
   Twilio credentials before the release with durable spending caps is deployed.
2. Keep `GEOIP_DB_DIR` on persistent storage where possible. Access data refreshes
   weekly; startup failures retry after 15, 30, then 60 minutes. No historical
   hosting-ASN fallback is used while the data is missing.
3. Agent upgrade is optional for Core compatibility. `vox-manager.sh` supplies
   host `VOX_LINK_TYPE` and `VOX_PUBLIC_IP_ON_IFACE` values; upgraded agents send
   richer link/network/SIM reports. Old agents continue running, with missing
   fields left unknown or absent.
4. DialF must supply the operator fields in the [contract](#dialf-sim-operator-contract)
   before its SIM can earn a `sim` tag. Call control, recording, and other phone
   primitives remain unchanged.

No mandatory new environment variable or plugin; lookup credentials are configured
in the console. Deployment settings and source licences are in `docs/DEPLOYMENT.md`.
Results from before the release stay untagged.

## Testing

- `shared/tags.ts` unit tests: normalisation, key/value syntax, the closed
  `link` set, the 16-tag cap, one value per key, ASN map, `effectiveTags` per board.
- Claim freezing (integration): flow tags + agent tags + detected isp/link land
  on the job; editing the flow or agent afterwards doesn't change it; both claim
  entry points share the same atomic claim path.
- Board rule (integration): a hand-set `isp` on a public agent counts on My Evals
  and Community but not Mainline; the detected one counts on Mainline.
- Filter and groupBy on each endpoint, including `untagged` and v1 parity with
  the console.
- Permissions: only flow editors edit flow tags; only the agent's operator edits
  agent tags; `observed_ip` still never exposed.
- Number lookup: a stub Twilio server (real HTTP, in tests only) — mapping,
  cache reuse within 30 days and refresh after, no lookup for secret numbers,
  toll-free → none, failure never blocks the save, no credentials → off.
- Daemon: link detection on a fake `/sys` tree; `VOX_LINK_TYPE` wins.
- E2E: tag a flow, filter and group the leaderboard.
- Mutation-check each rule.
- Privacy: exclude both `observedIp`/`observed_ip` and `accessIp`/`access_ip` from
  responses, even to admins. Never log or persist a full SIM number in the cache.
- Lookup/SIM regressions: invalid-number reuse across callers, 30-day expiry,
  positive/negative transitions, transient failures and timeouts, cap/refund
  accounting, full-number equality, generation fencing across processes, and
  SIM memo expiry measured from the original provider lookup time.
- Location regressions: preserve same-IP classifications while data is unloaded;
  emit unknown after a move; reject late old-IP and missing-IP writes on both
  private and public paths, including checks without access data or GeoIP.
- Data ingestion: fixture parsers and source limits; efficient sorted/merged range
  lookup with a benchmark using at least 100,000 ranges. Agent tests use fake OS
  trees/command runners; no-shell interface validation must reject unsafe names.
- Run HTTP integration tests against a server built from the tested checkout and
  an isolated database, not a stale dev process. Migrations use the runner, never
  `db:push` on a runner-managed database. Stubs belong only in tests.

Validation recorded for #258, including #268 and the multi-instance SIM-clear
fix, on 2026-11-04: 277 unique focused tests passed, including HTTP/privacy/heartbeat tests,
PostgreSQL-backed regressions, and migration-recovery tests. `npm run check` and
`npm run build` passed, with existing bundle-size/CJS warnings. This is not a claim
that the full repository or E2E suites were rerun for the follow-up.

## Last mile vs datacenter (`access`)

**Why.** A result measured from a home or office connection is what real end users
experience: it has a **last mile** (Wi-Fi, cable/DSL/fibre access, a home router).
A result measured from a server in a datacenter doesn't. Last mile counts more, so
every result says which it was. The ISP name alone can't tell: AT&T (AS7018)
serves homes, offices and colocation on one network number.

### Decisions (made in discussion)

| Question | Decision |
|---|---|
| Name | `access:lastmile` · `access:datacenter` · `access:unknown` (cloud, VPS, colo and dedicated servers all live in a datacenter; an office server doesn't — and it matches region trust's existing `datacenter` class). |
| Who sets it | **Only the system.** `access` is a reserved key: refused on flows and agents, absent from the tag editor. |
| How it's valued | Every view can show the split: a toggle **All / Last mile / Datacenter** (default **All**, console and API) and last-mile vs datacenter side by side per provider row. |
| Where | Same branch and release as network tags. |

### Signals

| Signal | Measured by | Pushes toward |
|---|---|---|
| Tor exit or an IP in the **VPN range list** (X4BNet) | Core | `unknown` — the real path is hidden |
| Agent IP inside a **datacenter IP range** (X4BNet + ipcat hosting/cloud range lists, by range not ASN — catches an access ISP's colo ranges when listed) | Core | `datacenter` |
| **PeeringDB network type** of the ASN: Content (only when an operator supplies a PeeringDB export — its AUP rules out downloading one) | Core | `datacenter` |
| PeeringDB type Cable/DSL/ISP (access network) | Core | `lastmile` evidence (describes the network, not the line — never enough alone) |
| **APNIC end-user estimates** per ASN (free, labs.apnic.net): a large share of end users and no server presence → access network | Core | `lastmile` evidence (the stronger access-network signal) |
| **Mobile carrier ASN** (APNIC/PeeringDB + a curated list: T-Mobile, Verizon Wireless, AT&T Mobility, …) — carrier-NAT IPs carry no servers | Core | `lastmile` on its own |
| **Reverse DNS** of the IP matches a residential/access pattern (`lightspeed`, `res.`, `pool-`, `cpe-`, `dsl`, `cable`, `dyn`, `fios`, `broadband`, …) | Core | `lastmile` evidence |
| Reverse DNS matches a server/colo pattern (`static.…hosting`, `colo`, `vps`, `server`, `dedicated`, …) | Core | `datacenter` |
| Agent: a **cloud metadata service** answers *with its provider's signature* (AWS IMDSv2 token or an `instance-id` listing, Azure JSON with `compute`, GCP `Metadata-Flavor: Google`; redirects not followed) — a bare HTTP answer is not enough, since transparent proxies, captive portals and NXDOMAIN-hijacking ISPs answer too | agent | `datacenter` |
| Agent: public **IPv4** directly on the default interface (no home router). IPv6 is ignored: dual-stack home ISPs and IPv6 hotspots give every device a global address; an IPv6-only interface reports nothing | agent / host | `unknown` (an office server may have one — not proof of a datacenter) |
| Agent: link `wifi`/`cellular`, or a private home-router / carrier-NAT gateway | agent | consistent with last mile — never proof on its own |

### Location vs access — one pipeline, two answers

Location (region/site) stays a **separate property**, not a tag: it routes jobs
(region targeting, claim matching) and files results under a site ID, with its own
hierarchy and trust ladder. Tags only describe a result for analysis. They answer
different questions — location trust: *can we believe where this agent is?*;
access: *is there an end-user last mile?* — and diverge often (a home on 5G home
internet is last mile but GeoIP-low-confidence; an unlisted VPS is location-trusted
but a datacenter). So location trust is not used as the last-mile signal.

But there is **one classifier**: the existing location check (`server/location.ts`,
run on register, IP change and every `LOCATION_RECHECK_HOURS`) computes both region
+ trust **and** access in the same pass, with all signals in one place next to the
GeoIP and Tor checks. Location trust's `datacenter` value is then derived from
`access = datacenter` instead of its old hosting-ASN list, so the two can never disagree.
This changes no gating: `trusted` and `datacenter` are treated identically everywhere
(`REGION_ELIGIBLE_TRUST`, the Community gate in `storage.ts`); only the badge tells
them apart. `access` is surfaced for analysis as a system-only detected tag.

### Decision rule (Core, in the location pipeline: `server/access-class.ts` called from `server/location.ts`)

1. Tor / VPN → `unknown`.
2. Any datacenter signal (a datacenter IP range — X4BNet / ipcat; PeeringDB Content, only when an operator supplies the export; server-style rDNS; cloud metadata) → `datacenter`. (There is no hosting-ASN list any more — it was deleted with the downloaded data's arrival.)
3. No datacenter signal, the agent reports nothing contrary (no public IP on the interface), **and either**
   - a **mobile carrier** ASN, **or**
   - **two independent Core signals**: an access network (APNIC end-user estimate or PeeringDB Cable/DSL/ISP) **and** a residential reverse-DNS name
   → `lastmile`.
4. Otherwise → `unknown`.

A false `lastmile` hurts more than a missing one — last mile is the valued class —
so one weak signal is never enough: an AT&T colocation server with a generic
reverse-DNS name (access network, no residential name) stays `unknown`.

**Public agents too.** Access is detected for every agent, including public ones
whose region an admin configures. Most of today's agents are likely datacenter, so
expect the Last mile view to start small and much to read `unknown` — honest, not a bug.

**Classifier version.** The reason frozen with each job carries a version and the
signals that decided it (e.g. `v1: eyeball-asn + residential-rdns`, `v1: dc-range`),
so when data or rules improve, older results stay explainable and comparable.

**Known limit — residential proxies.** `observed_ip` is the address of the agent's
API calls to Core, not of its media path. A datacenter agent that routes its Core
traffic through a commercial residential proxy looks like a home connection while
the measured call still runs from the datacenter. Region trust has the same limit
today; nothing Core sees from that IP can fully close it. A later step could
cross-check the media path's source address where the target platform reports it.

**IP/signal changes and late checks.** Register/heartbeat lock the current agent
row, merge only the reported signal fields, record the observed IP, and reserve
the next `location_check_gen` before starting a location check. Trigger decisions
use that locked row, not an earlier request snapshot. Checks run on registration,
IP/binding changes, signal changes, staleness, and pending region hysteresis;
unchanged heartbeats do not advance the generation unless another trigger applies.
The short transaction commits before DNS/catalog work starts, and heartbeat
detection remains asynchronous. Concurrent partial reports preserve both fields.
Claims never wait for rDNS: they reuse access
only when its normalized `access_ip` matches the current `observed_ip`, otherwise
freezing `access:unknown` with reason `v1: ip-changed` (or `v1: not-classified`
without a prior binding). Both location-write paths require the reserved generation
to still match, as well as the checked IP, separately from optional access fields,
including no-data outcomes. Older same-IP checks, including A-to-B-to-A signal
changes, cannot overwrite newer access, trust, check times, or location state.
A no-IP check may
write only while `observed_ip IS NULL`; rejected checks return the current stored
location and do not update marketplace listings. A rejected write may consume a
site sequence number, leaving a harmless gap. This binds access tags to the IP;
it does not add synchronous location detection or change location-trust gating.

**Only Core can earn `lastmile`.** Agent signals can only push a result to
`datacenter` or `unknown`, never to `lastmile` — so a modified agent can't dress a
server up as last mile (its IP still sits in a datacenter range or lacks access
evidence). Nobody gains by faking "datacenter", so trusting the agent in that
direction is safe. Disagreement means `unknown`, never a guess.

### Where it's computed and stored

- Reverse DNS and range checks are too slow for the claim transaction, so the
  location check computes access (register, IP change, and the existing
  `LOCATION_RECHECK_HOURS` cadence on heartbeat) and stores it on the agent:
  `eval_agents.access_class` + `access_reason` + `access_ip` (system-only; never
  writable through any route, and the IP is never returned to clients). At claim,
  `buildJobTags` only reuses a class bound to the agent's current observed IP;
  a changed IP freezes `access:unknown` until checked again. An old classification
  without an IP binding is also unknown, and the next heartbeat rechecks it.
  A late check for an old IP cannot overwrite the new IP's result. The class is a `detected` tag
  `access:<class>` (same transaction as today). Analyze jobs still get `[]`.
- Agent signals travel on register/heartbeat as `netSignals: { cloudMetadata, publicIpOnInterface }`
  (omitted when unknown). In a container the interface is a veth, so `vox-manager.sh`
  measures `publicIpOnInterface` on the host and passes `VOX_PUBLIC_IP_ON_IFACE`;
  the metadata probe works from inside a container (short timeout, once per beat
  at most every 10 minutes).
- Data: datacenter/VPN ranges and APNIC end-user estimates are downloaded and
  refreshed in-app weekly next to the GeoIP databases (`server/access-data-refresh.ts`,
  following the `server/geoip-refresh.ts` pattern), stored under `GEOIP_DB_DIR`.
  PeeringDB is read only from an operator-supplied export; Vox never downloads
  it automatically. Missing data ⇒ fewer signals ⇒ more
  `unknown`, never a wrong `lastmile`. Licences and terms of each source (X4BNet,
  ipcat, PeeringDB bulk export and rate limits, APNIC) are checked before use and
  credited on the page like DB-IP. The hardcoded 19-ASN list
  (`server/data/asn-classification.json`) is **deleted**: hosting/datacenter and VPN
  detection come only from the downloaded data. A list line wider than /8 (IPv4) or
  /16 (IPv6) is dropped as invalid (a `0.0.0.0/0` in the VPN list would anonymize
  everyone), and a refresh refuses a download covering more than 5% of the IPv4
  space (VPN list; 0.07% today) or 20% (datacenter lists; 9.2% today), an IPv6
  list covering more than 0.0005% (VPN; 0.00011% today) or 0.005% (datacenter;
  0.00126% today) of 2000::/3 — the global unicast space; one home ISP's /20 is
  0.00076% of it, a single /16 0.0122% — or a download larger than 64 MB,
  keeping the previous copy.
- Until that data has loaded once, a check that would have read `trusted`/`datacenter`
  is **capped** — and a capped check writes nothing: not the region, not trust, not
  access, not the check time. The stored answer stands (an agent that was Verified
  stays Verified, and jobs on the same IP freeze its last real answer; a moved
  agent's jobs freeze `access:unknown` until the new IP is checked), an agent
  that never had one stays Unverified (fail closed), and because the check time
  doesn't advance the next heartbeat re-checks, so the first beat after the data
  loads classifies it. Likewise an access answer of `no-data` (public IP, data
  unloaded) leaves the stored access and check time alone while unambiguous trust
  outcomes (Tor, no geo) are still written.
- The Agents page shows each agent's access class and reason (read-only).

### Analysis

`access` is an ordinary detected tag, so the existing machinery serves it:
`tag=access:lastmile` filters, `groupBy=access` splits. The console toggle maps to
that filter (default All); the Leaderboard adds last-mile and datacenter columns
per provider row. The v1 API: same `tag`/`groupBy` (default unchanged = all).
`access` uses the detected value on every board (no hand-set value can exist).

### Testing

Decision-rule unit tests per signal combination (incl. "agent can never earn
lastmile" and "disagreement → unknown"); range-list and PeeringDB parsers on
fixture files; rDNS patterns on real-world example names; reserved-key refusal on
both ends; claim freezing; filter/groupBy on `access`; daemon metadata probe and
`VOX_PUBLIC_IP_ON_IFACE`; e2e toggle. Mutation-check the rule.

## `sim` is system-only — detected on both sides, must match

`sim` (our own phone's SIM carrier — the calling side of phone tests) is set only by
the system, like `access`: refused on flows and agents, absent from the tag editor.
Agents keep `isp`/`link` (correctable) + custom keys.

| Side | Source | Gives |
|---|---|---|
| Phone | DialF reads the SIM card (needs a DialF addition: `sims.list` today returns slot / number / default only) | operator name + network code (MCC-MNC, e.g. 310-260) |
| Core | Twilio Lookup of our SIM's own number (the agent reads it from DialF `sims.list`, as for `${phoneNumber}`; reported on register/heartbeat with the operator) — same provider, cache and credentials as the `line` lookup | carrier name + network code |

- **Match** — compared by network code, not by name → `sim:<carrier>` (detected),
  value from the Core side's carrier name through the `lineFromCarrier`-style map
  (radio network, e.g. a Mint Mobile SIM → `t-mobile`, since MVNO SIMs and numbers
  both report the host network's code).
- **Mismatch or either side missing** → no `sim` tag. Never a guess.
- Stored on the agent (`eval_agents.sim_carrier`, system-only, recomputed when the
  reported number/operator changes or the 30-day lookup cache expires) and frozen
  at claim as a `detected` tag — phone jobs only.
  Positive and invalid-number memo expiry is measured from the provider's
  original `lookedUpAt`, never extended by another 30 days on a cache hit.
- **Limit:** both inputs reach Core through the agent — **the phone side of `sim` is
  agent-reported**, filed as `detected` once Core's own lookup agrees. A modified
  agent could report a different real number plus a matching operator; Core's lookup
  is of a real number so it can't invent a carrier, but it can't prove which SIM is
  in the phone. Mainline trusts it because Mainline agents are admin-run.
- A phone agent that stops reporting a valid `sim` (SIM pulled, phone unplugged) has
  its stored `sim_carrier` cleared (reason `v1: no-sim-report`) — no stale carrier is
  frozen onto later phone jobs. Agents without the `phone` capability are left alone.
- Every no-report heartbeat executes a conditional database update, even if this
  Core instance's memo remembers a prior clear. An in-flight recomputation from
  another instance advances the generation on that clear, invalidating its
  pending result; an already-settled carrier is cleared too. Already-cleared
  rows with no pending recomputation are not rewritten or given a new generation.
  Unchanged valid reports retain the query-free memo fast path.
- Overlapping reports: the newest wins, whichever lookup finishes last. Each recompute
  or clear takes the next `eval_agents.sim_report_gen` when it starts (negative while
  a recompute is in flight), and a recompute writes only if its generation is still
  the latest, checked under `SELECT … FOR UPDATE` — so it holds across Core processes
  (migration 0062).
- **Spending:** for the same reason a token holder could make every heartbeat a paid
  lookup of a fresh number. Core acts on `sim` only from agents whose current
  capabilities include `phone`, allows one uncached lookup per agent per UTC day,
  5 per token creator across all their agents, and the SIM path's **reserved share of
  200 a day** (`SIM_LOOKUPS_PER_DAY`). Flow `line` lookups have their own share of
  300 a day (`FLOW_LOOKUPS_PER_DAY`) plus 10 per flow editor per day — 500 in all
  (`PAID_LOOKUPS_PER_DAY`, the bill's ceiling). Reserved, not pooled: free accounts'
  flow edits can never starve our phone agents' SIM checks, nor the reverse
  (server/paid-lookup-budget.ts; counters durable in Postgres `paid_lookup_usage`,
  scopes `global-flow` / `global-sim`, reserved atomically);
  past a cap the answer is a
  non-definitive `v1: rate-limited`, handled like `lookup-failed` (a stored answer
  for the same number and code is kept; retried after 10 minutes). Cache hits are
  free and never counted; a provider call that got no billable response
  (network error/timeout, or a non-2xx other than 404) is refunded. Twilio
  bills any 2xx and 404, so those keep the reservation even when a later
  step (the cache write) fails, and so does a provider that throws.
- Privacy: our number is stored redacted (last 4) on the agent, plus a keyed hash
  (`sim_number_hash`) so "same number" never relies on the last 4; the full number
  is stored nowhere — `number_lookups` is keyed by the same keyed hash.

## DialF SIM-operator contract

This is the additive `sims.list` handoff originally requested on 2026-10-22.
The Vox client already accepts these fields; their availability depends on the
installed DialF version. Related phone requirements remain in
`2026-09-21-dialf-requirements-for-vox-phone-eval.md`.

Each SIM entry should supply an operator name plus MCC and MNC strings:

```json
{
  "slot": 0,
  "number": "+15551234567",
  "is_default": true,
  "operator_name": "T-Mobile",
  "mcc": "310",
  "mnc": "260"
}
```

- Android sources: `TelephonyManager.getSimOperatorName()` or
  `SubscriptionInfo.getCarrierName()` for the name;
  `SubscriptionInfo.getMccString()` / `getMncString()` for separate codes.
  `TelephonyManager.getSimOperator()` is also usable as a concatenated
  five- or six-digit MCC+MNC string.
- Vox accepts `operator_name` or `operator` for the name. A numeric value in
  either is parsed as MCC+MNC when a separate pair is absent. MCC has three
  digits; MNC has two or three. Keep codes as strings to preserve leading zeros.
- The daemon selects the default SIM with a number, otherwise the first with
  a number, matching its existing `${phoneNumber}` selection. It reports
  `sim: { number, mcc, mnc, operatorName? }` only with a valid E.164 number and
  valid code pair. An older DialF response without codes produces no report.
- Core compares the codes, not carrier names; an MVNO name can differ from
  its host network. The operator name is diagnostic, not independent proof of
  the carrier or the physical SIM in the phone.
- No IMSI or ICCID is requested. Operator metadata describes the network;
  the phone number keeps the redaction/HMAC handling described above.
- `job.run`, call control, recording legs, and the other existing phone
  primitives are unchanged. Missing fields do not block normal phone jobs.

## Agent badge follows `access`

The Eval Agents page separates three properties: **Tier** shows only
Public/Private/Shared/Team; **Region** includes the **Verified** or **Unverified**
location badge for non-public agents; **Tags** shows `access:lastmile`,
`access:datacenter` or `access:unknown` alongside detected link and hand-set tags.
Public agents use an admin-configured region and have no location-verification
badge. Access tags are system-controlled and read-only; their tooltip explains
the classification and its reason. A never-classified agent has no access tag
until one is available. Legacy `location_trust = datacenter` supplies the existing
datacenter fallback when `access_class` is absent.

Stored `location_trust` values keep their names, but `datacenter` is derived from
`access` (see "Location vs access"). This is a display-only separation: no gating
changes, since `trusted` and `datacenter` are handled alike.

## Group by region

Region stays a separate property (not a tag), but the views can split by it:
`groupBy=region` on the console metrics endpoints and `/api/v1/metrics/*`, and
"Region" in the Group-by control next to the tag keys. The group value is the
result's region — the location base of its site (e.g. `apac-in-mumbai`), or for an
uploaded analysis its `recording_region`; results with neither group as
`unattributed`. `region` is therefore a reserved groupBy key (not a tag key —
tags can't use it). The region filter is unchanged.

## Implementation map

The original task plans are retained here as module/verification maps, not
unchecked instructions to rebuild the feature. Runtime contracts above take
precedence over earlier proposals. Stack: TypeScript, Express, Drizzle/PostgreSQL,
React/TanStack Query, Vitest, and Playwright.

### Phase 1: Tags, lookup, and analysis

| Original task | Implementation boundary | Primary verification |
|---|---|---|
| 1. Shared tag model | `shared/tags.ts`: syntax, end-specific permissions, suggestions, mapping, filtering, effective values | `tests/tags.test.ts`; JS/SQL rule consistency |
| 2. Schema and snapshots | `shared/schema.ts`, `server/migrate.ts`, `server/storage.ts`: flow tags/lookup in `JobSnapshot`, agent tags/link, job tags, lookup cache | `tests/network-tags-schema.test.ts` |
| 3. API | `server/routes.ts`, `server/routes-api-v1.ts`: normalized flow tags, operator-owned agent edits, optional heartbeat fields, minimal response shapes | `tests/network-tags-api.test.ts`; admin-route/privacy checks |
| 4. Atomic claim freezing | `server/job-tags.ts`, `claimEvalJob` in `server/storage.ts`: snapshot + agent + detected tags in the claim UPDATE | `tests/network-tags-claim.test.ts`; edits after claim never rewrite history |
| 5. Number lookup | `server/number-lookup.ts`, `server/paid-lookup-budget.ts`, `server/sensitive-paths.ts`: provider seam, cache, safe async writes, credentials, spending | `tests/number-lookup.test.ts`, `tests/number-lookup-api.test.ts` |
| 6. Metrics | `server/metrics-params.ts`, `server/tag-sql.ts`, storage and console/v1 routes: tag AND filters, grouping, metadata, cache keys | `tests/network-tags-metrics.test.ts`, `tests/network-tags-sql.test.ts`, `tests/network-tags-detail.test.ts` |
| 7. Agent link detection | `vox_eval_agentd/link-type.ts`, `vox-agentd.ts`, Dockerfile, `scripts/vox-manager.sh`: OS detection and host override | `tests/link-type.test.ts`, daemon/upgrade tests; real Docker build when packaging changes |
| 8. Console | `tag-input.tsx`, `line-lookup.tsx`, `metrics-tag-controls.tsx`, `twilio-lookup-card.tsx`; flow, agent, job, realtime, and leaderboard pages | `tests/e2e/network-tags.spec.ts`; screenshot review of changed views |
| 9. Docs | `CLAUDE.md`, `README.md`, `docs/DEPLOYMENT.md`, `docs/openapi.yaml`, `client/src/pages/api-docs.tsx` | Keep runtime, API, and deployment contracts synchronized |

### Phase 2: Access, SIM, badges, and region grouping

| Original task | Implementation boundary | Primary verification |
|---|---|---|
| 1. Access data | `server/access-data.ts`, `server/access-data-refresh.ts`, `server/data/mobile-carrier-asns.json`: fixture parsers, sorted range lookup, source limits, refresh | `tests/access-data.test.ts`, `tests/fixtures/access/` |
| 2. Classifier and location | `server/access-class.ts`, `server/location.ts`, schema/storage: one location/access pipeline, versioned reasons, checked-IP and generation fencing | `tests/access-class.test.ts`, `tests/location-access.test.ts`, `tests/location-check-generation.test.ts`, `tests/location-catalog.test.ts`, `tests/location.test.ts` |
| 3. Agent network signals | `vox_eval_agentd/net-signals.ts`, daemon, upgrade script, `server/net-signals-update.ts`: signed metadata probes, host public-IPv4 signal, optional reports | `tests/net-signals.test.ts`, `tests/net-signals-core.test.ts`, daemon/upgrade tests |
| 4. System-only SIM and tags | `vox_eval_agentd/dialf-client.ts`, `server/sim-carrier.ts`, lookup, shared tags, claim freezing: MCC/MNC match, durable generations, redaction/HMAC | `tests/dialf-client.test.ts`, `tests/sim-carrier.test.ts`, reserved-key/claim tests |
| 5. Analysis and UI | Metrics routes/storage, `client/src/lib/access-view.ts`, `access-text.ts`, Agents badge, access toggle/columns, `groupBy=region` | `tests/network-tags-region-access.test.ts`, `tests/access-toggle.test.ts`, E2E |
| 6. Documentation and DialF handoff | This design, deployment/API docs, and the SIM-operator contract above | Preserve the additive phone contract and source licensing requirements |

Metadata probes have a 500 ms timeout, reject redirects, validate provider-specific
responses, and cache for 10 minutes. Public IPv4 checks ignore IPv6-only global
addresses. Unknown agent fields are omitted, not manufactured. Module changes
must preserve the security and fail-closed rules above; no production lookup or
live dataset is needed to exercise fixture-backed tests.

## Mid-evaluation network history

The network baseline stays in `eval_jobs.tags`, frozen atomically at claim.
Neither heartbeats nor classifier refreshes rewrite it. A sticky, system-owned
`network_changed` flag records detected handoffs; `network_monitoring` separately
records `unknown`, `monitoring`, `complete`, or `incomplete` coverage. Missing
evidence is not evidence of stability. Analyses do not inherit the analyzing
machine's network history.

Events are append-only snapshots in `eval_job_network_events`, for example:

```json
{"event":"initial","timestamp":1793836800000,"tags":{"link":"wifi","isp":"att","line":"twilio"}}
{"event":"network_change","timestamp":1793836810000,"tags":{"link":"cellular","isp":null,"line":"twilio"}}
```

The actual API also includes source, relative offset, and a sequence. Agent
events report local topology changes, not a newly certified ISP. A buffered
event must never inherit the reconnect IP's ISP. Core records independently
observed egress/link changes at receipt time; classification refreshes alone
are not handoffs. Custom/line tags remain the baseline dimensions. IPs, leases,
raw interface details and local fingerprints never enter the public timeline.
Internal claim/egress state lives in a separate table, not job response rows.

### Delivery and execution identity

No `attempt_id` is added. Identity is the existing job ID, agent ID, lease ID,
Core-issued claim `startedAt`, and lease-global increasing event `seq`.
Claim timestamps are strictly increasing per job and millisecond-precise so
the JSON round trip cannot collapse two claims. Reclaims reset active coverage
and event scope; an old timestamp/lease cannot write a successor's history.

Optional `networkReport` on heartbeat and completion contains protocol version
1, the job/start identity, first/last sequence, sticky change/count and continuity
summaries, the eviction high-water mark, and up to 128 events. Core returns
`networkAck` with the same job/start identity and the committed event IDs. An
agent removes only those IDs: events created while a request was in flight stay
queued. Lost acknowledgments can retry identical events; the unique database
identity deduplicates across Core instances. Authenticated, current-lease
heartbeats return 200 even when their network report is rejected. A separate
`networkReportStatus` distinguishes accepted, partial, rejected and retryable
storage outcomes. Only saved events appear in `networkAck`; rejected events
have explicit sequence/reason entries. The daemon removes only accepted or
explicitly rejected entries from the submitted batch, preserving all other
pending events and observations collected while the request was in flight.
Sequence conflicts return a resynchronization hint when needed. Old-execution
feedback never mutates a successor's buffer or history.

The daemon samples every second; heartbeat delivery remains every 30 seconds.
Only unacknowledged details are retained, for at most two monotonic minutes and
128 entries. Sticky summaries survive eviction. Core never expires accepted
events on that timer. Gaps/suspension/unsupported observations fail closed. A
final sample and `monitoring_end` accompany success or failure. Final events,
coverage, job status and result commit together before any acknowledgment.
Telemetry storage uses a savepoint: malformed or conflicting network metadata
cannot roll back an authorized measurement. Rejected or unavailable telemetry
marks monitoring incomplete; database failures request retry without discarding
pending events. Missing pre-upgrade history resumes at an incomplete checkpoint,
never a fabricated fully monitored baseline. Completion carries a separate
claim `startedAt` so old-execution results and superseded leases remain fenced.
Timestamp-less legacy completions remain compatible only on a job's first
execution. After a retry or archived prior claim, Core requires the claim
timestamp under the finalization lock; a delayed legacy result cannot be
mistaken for its same-agent/same-lease successor. Upgraded daemons echo it.
The job-level incomplete flag is authoritative; updating its telemetry-state
mirror is best-effort behind a separate savepoint. A failed telemetry-table
write therefore cannot poison result finalization. A lost database connection
or a failure of the result/job tables themselves still returns a retryable
server error: no database-backed result can commit while its database is down.
More than two minutes without delivery makes monitoring incomplete even if
local sampling continued; incomplete is sticky after reconnection. This does
not change the separate five-minute stale-agent job-recovery rule or 90-minute
execution deadline.
Installer safety is independent of these timers: a failed local `/health`
request cannot establish that the process is idle, even if Core may already
have recovered its job. For running containers, the manager normally requires a
successful, valid explicit idle response before an automatic stop/restart;
unknown or busy health is retried for five minutes and then requires explicit
force-stop confirmation (No/EOF skips). Docker-native inactive/restarting states
(`created`, `exited`, `dead`, `restarting`) get a 10-second recheck: still inactive
means replacement can proceed without health polling; running again means normal
health checks. Failed state inspection and paused containers do not establish
inactivity. The explicit `--force` option skips health waits and confirms
installation/replacement for automation, with warnings that it may interrupt
active work or drop DialF support; it never bypasses image preflight validation.
For maintenance, the operator sets `VOX_INSTANCE_DISABLED=true` in the env file
before stopping the instance. The manager then skips every Docker operation,
even with `--force`; unset/false re-enables normal state-based recovery. The flag
does not stop an already running process and does not affect script self-updates.
Complete coverage needs a continuous monitor and every sequence from start
through end; summaries alone cannot manufacture it. Acknowledged events that
have left the agent queue still count toward coverage in Core.

Change count is an observation count: Core and agent may see the same handoff,
so it is not advertised as an exact count of physical transitions. The native
sampler watches route/interface/source/gateway (and Linux Wi-Fi BSSID when `iw`
is available). This is best-effort observation, not a guarantee that a sub-second
handoff or an egress-only change between heartbeats can always be detected.

### Strict dashboards and rollout

Server-side metrics overview/hour/day buckets, zoom detail, region availability
and public v1 default to `network=strict`: only complete, unchanged runs qualify.
The Real-time and Leaderboard UIs instead default to All, as described below.
Uploaded Analyze recordings are exempt because the analyzing machine's network
does not describe the recording; they remain visible in My Evals and are not
counted as unstable or unverified network runs.
Legacy, unsupported and incomplete runs are excluded, even when their change
flag is false. `network=all` explicitly includes them without altering baseline
grouping. All cache/query keys include policy. The console exposes a positive
Strict switch, a scoped coverage API, and authorized job timelines.
Normal job/result history is not filtered away.

**Real-time UI follow-up (2026-11-05):** Real-time deliberately defaults to All
networks, explicitly passing `network=all` for overview, zoom detail and region
availability. The All button starts selected with advanced filters and Strict
hidden/off; clicking it reveals the controls, and reselecting it resets network
tags/grouping and Strict without changing primary selections. Extended controls
sit immediately below the header selectors. The information icon, Strict label and switch precede the
time range. Desktop tabs remain anchored beneath the status line when the second
filter row opens. The UI no longer displays or polls coverage counts.
API defaults remain strict. Network policy, tags and grouping are local page state
and reset to All on refresh; they are never written to the page URL. Legacy
`network`, `tag` and `groupBy` URL parameters are ignored and removed without
discarding unrelated URL state. Strict benchmarks are selected via the UI switch.

The shared Strict information popover uses the heading "Strict agent health
checks". It explicitly states that checks currently cover network monitoring and
detected network changes only; CPU and memory checks are not implemented. Turning
Strict off includes otherwise eligible runs with issues or missing monitoring,
but does not bypass other filters. Grouping still uses the frozen initial network
tags. This terminology change does not add health measurements or change API
parameters or filtering behavior.

**Leaderboard UI follow-up (2026-11-05):** Leaderboard shares the compact Strict
placement, extended-filter row and All reset/collapse behavior with Real-time.
It also defaults to All networks with controls collapsed and Strict off. Filter
selections are temporary and reset on refresh, just like Real-time. Ranking
calculations and server defaults are unchanged.

Both pages compose `client/src/components/metrics-filter-bar.tsx`. It owns the
two-row layout, initial expansion and All reset behavior, and renders the shared
Strict/tag controls. Pages share `useMetricsTagState` for temporary network filter
state and retain their own API query keys. They supply their own
primary selectors and optional trailing actions (providers/refresh on Real-time).

Deploy Core schema 66 first, then updated daemons. Older daemons still run but
remain unverified. Docker startup overrides cannot prove continuous monitoring:
use the read-only live host sampler documented in `vox_eval_agentd/README.md`.
Missing/stale host observations never silently qualify as stable. Empty strict
dashboards during rollout are expected; operators can explicitly choose All.

## Migration history

| File | Schema version | Purpose |
|---|---|---|
| `0057_network_tags.sql` | 58 | Flow/agent tags, line lookup, frozen job tags, initial number cache |
| `0058_access_sim.sql` | 59 | System access/SIM fields and lookup MCC/MNC |
| `0059_agent_net_signals.sql` | 60 | Optional agent network signals |
| `0060_sim_number_hash.sql` | 61 | Full-number HMAC for SIM equality without plaintext storage |
| `0061_paid_lookup_usage.sql` | 62 | Durable paid-lookup caps and HMAC-keyed number cache; remove plaintext cache keys |
| `0062_sim_report_gen.sql` | 63 | Latest SIM report wins across Core processes |
| `0063_lookup_validity_access_ip.sql` | 64 | Definitive invalid-number cache flag and internal checked-IP binding |
| `0064_location_check_gen.sql` | 65 | Persisted generation for same-IP signal races and atomic partial-report merging |
| `0065_job_network_events.sql` | 66 | Immutable per-execution event history, private claim state and strict coverage flags |

Append migrations to `server/migrate.ts`; never rewrite an applied step. The
negative-cache flag defaults to false for old rows. Access IP bindings are not
backfilled from whichever IP an agent happens to have at deployment time.

## Out of scope (v1)

- A comparison page (side-by-side distributions per tag value) — v2 on this data.
- Native-app tags — the same keys apply when native testing lands.
- Tags on eval sets (a scenario isn't a network path).
- Leaderboard completeness beyond its existing 1,000-row limit (#266).
- Further tag-filter cost and caching improvements (#267).
