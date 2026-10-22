# Network tags: compare results by line provider, ISP and link

**Status:** design, approved in discussion · 2026-10-22

## What and why

A result today says **which provider**, **which region** and **web or phone**.
It doesn't say **which network path** the conversation took — and that can
matter as much as the provider. The same voice agent behind a Twilio number and
behind a Bandwidth number can answer at different latency; the same eval run
from a Starlink-on-WiFi host and an AT&T-fibre host can measure differently.

**Tags** record that path on every result, so the boards can be filtered and
split by it: "ElevenLabs × Twilio vs ElevenLabs × Bandwidth", "only results
measured over Ethernet", "Starlink vs everything else".

## Decisions (made in discussion)

| Question | Decision |
|---|---|
| Phone line provider — lookup or manual? | First answer was manual-only; revised: **automatic lookup is in this design**, with manual tags as the fallback and the override. |
| Which lookup service? | **Twilio Lookup v2, Line Type Intelligence** (~$0.008/lookup, self-service, worldwide; returns `carrier_name` and line type). Behind a small seam so a second service (e.g. Telnyx) can be added later. |
| How free are tags? | **Known keys + custom keys.** Known: `line`, `isp`, `link`, `sim` — suggestions and normalisation. Custom keys allowed (`codec:opus`, `vpn:on`), filterable, no suggestions. |
| Detected vs hand-set — which counts? | **Both kept.** The agent's operator may correct a detected tag. My Evals and Community use the hand-set value; **Mainline uses the detected value** for `isp`/`link` (a public agent's operator could otherwise mislabel results others rely on). |
| Where does analysis show in v1? | **Filter + Group by on the existing views** (Leaderboard, Community, My Evals) and the same parameters on the public API. A comparison page is v2. |
| Where are tags stored? | **The simpler shape:** a hand-set `tags` field on the eval flow and on the eval agent, one reported link type on the agent, and **detected values computed at claim, not stored ahead**. |

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
  - `sim` — suggestions: att, verizon, t-mobile, … (free value).
- One module, imported by the client form, Core's save routes and the agent, so
  they can't disagree (the `shared/placeholders.ts` pattern). Client-safe: no
  dependencies.

## Data model

| Table | Column | Content |
|---|---|---|
| `eval_flows` | `tags jsonb not null default '[]'` | hand-set by whoever can edit the flow (`isOwnerOrOrgManager`) |
| `eval_agents` | `tags jsonb not null default '[]'` | hand-set by the agent's operator (the token's owner) — a correction or an extra tag |
| `eval_flows` | `line_lookup jsonb` | the number lookup's answer for the flow's dialled number (value, carrier name, line type, time); null = not looked up |
| `number_lookups` | table | per-number cache: E.164, provider, carrier name, line type, mapped value, looked-up time |
| `eval_agents` | `link_type varchar(16)` | reported by the agent on register/heartbeat; null = not reported (an older agent) |
| `eval_jobs` | `tags jsonb` | frozen at claim (below); null for jobs claimed before the release |

One hand-written migration, registered in `server/migrate.ts`. No backfill:
older results are simply untagged.

Visibility: an agent's tags and link type are shown to whoever can see the
agent (operator name and link type only — never the IP; `observed_ip` stays
Core-internal).

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
  A container sees its own veth, not the host's NIC — `vox-upgrade.sh` passes the
  host's answer in (`VOX_LINK_TYPE`, detected on the host at upgrade time), and the
  daemon prefers it. Satellite can't be seen from an interface: it's inferred at
  claim from `isp:starlink` (or any satellite ASN in the map) unless `link` is set otherwise.
  Reported on every heartbeat like `capabilities`; an old agent reports nothing.
- **`sim`** — manual for now. DialF's `sims.list` returns slot / number / default
  but no operator name; a DialF issue asks for it (Android's per-SIM operator
  name). Once present, the agent reports it like `link`.
- **`line`** — by number lookup (next section); hand-set on the flow as the fallback and the override.

## Number lookup (`line`)

The number is the **agent's** number — the one in the flow's `call.dial` Setup
step, which we dial to reach the voice agent under test. (Our own SIM is the
other end: the `sim` tag.)

- **Where:** Core, when a phone flow is saved and whenever its dialled number
  changes (`server/number-lookup.ts`). Results are cached per number for 30 days
  (`number_lookups`: E.164 number, provider, carrier name, line type, mapped
  value, looked-up time) — about one paid lookup per number per month; a cached
  answer is reused across flows and owners.
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
- **Stored on the flow** as `line` with source `lookup` (a separate
  `eval_flows.line_lookup jsonb` — value, carrier name, line type, time — so the
  owner's hand-set `tags` stay theirs). The owner may still set `line` by hand.
- **Configuration:** an admin enters the Twilio Account SID + Auth Token on the
  console (Providers or Regions page, like the MaxMind key), stored encrypted in
  `systemConfig`. No credentials → lookup is off, `line` is manual only, the form
  says why. A failed lookup (network, 4xx) never blocks saving the flow; it's
  retried on the next save or by a "Look up again" button.
- **Disclosure:** the flow form notes that the dialled number is checked with
  Twilio Lookup to identify its line provider.

## Freezing at claim

Both claim SQL paths already freeze per-job facts (`token_visibility`,
`location_trust`). At the same point Core writes `eval_jobs.tags`:

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

## Which value a board uses

For each key, the effective value of a job is:

| Board | Rule |
|---|---|
| **Mainline** | `line`/`isp`/`link`/`sim`: the **detected** value (lookup / IP / heartbeat); a hand-set-only value counts as untagged — except `line` on a flow without lookup (no credentials, toll-free, secret number), where the flow owner's value counts, as the flow is the owner's claim anyway. Other keys: the flow's / agent's value. |
| **Community, My Evals** | the **hand-set** value when there is one, else the detected one. |

One function (`effectiveTags(jobTags, board)` in `shared/tags.ts`) — the SQL
filter and the JS grouping both go through it (the SQL side as a generated
predicate on the jsonb array).

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

1. Core release (migration, claim freezing, parameters, UI, number lookup).
   Detected `isp` works at once for every agent — it needs only Core. Lookup
   turns on when an admin enters Twilio credentials; existing phone flows are
   looked up on their next save or "Look up again".
2. Agent release: `link` reporting; `vox-upgrade.sh` passes `VOX_LINK_TYPE`.
3. DialF issue: SIM operator name → `sim` detected.

No env var, no plugin; lookup is configured in the console. Results from before the release stay untagged.

## Testing

- `shared/tags.ts` unit tests: normalisation, key/value syntax, the closed
  `link` set, the 16-tag cap, one value per key, ASN map, `effectiveTags` per board.
- Claim freezing (integration): flow tags + agent tags + detected isp/link land
  on the job; editing the flow or agent afterwards doesn't change it; both claim
  paths.
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

## Last mile vs datacenter (`access`) — added 2026-10-22

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
| Tor exit or `vpn` ASN (existing) | Core | `unknown` — the real path is hidden |
| Agent IP inside a **datacenter IP range** (public hosting/cloud range lists, by range not only ASN — catches an access ISP's colo ranges when listed), or an existing `hosting` ASN | Core | `datacenter` |
| **PeeringDB network type** of the ASN: Content / Hosting | Core | `datacenter` |
| PeeringDB type Cable/DSL/ISP (access network) | Core | `lastmile` evidence |
| **Reverse DNS** of the IP matches a residential/access pattern (`lightspeed`, `res.`, `pool-`, `cpe-`, `dsl`, `cable`, `dyn`, `fios`, `broadband`, …) | Core | `lastmile` evidence |
| Reverse DNS matches a server/colo pattern (`static.…hosting`, `colo`, `vps`, `server`, `dedicated`, …) | Core | `datacenter` |
| Agent: a **cloud metadata service** answers (169.254.169.254 / metadata.google.internal) | agent | `datacenter` |
| Agent: public IP directly on the default interface (no home router) | agent / host | `unknown` (an office server may have one — not proof of a datacenter) |
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
`access = datacenter` instead of its own 12-ASN list, so the two can never disagree.
This changes no gating: `trusted` and `datacenter` are treated identically everywhere
(`REGION_ELIGIBLE_TRUST`, the Community gate in `storage.ts`); only the badge tells
them apart. `access` is surfaced for analysis as a system-only detected tag.

### Decision rule (Core, in the location pipeline: `server/access-class.ts` called from `server/location.ts`)

1. Tor / VPN → `unknown`.
2. Any datacenter signal (range, hosting ASN, PeeringDB Content/Hosting, server-style rDNS, cloud metadata) → `datacenter`.
3. Core has last-mile evidence (PeeringDB access network **or** residential rDNS) **and** the agent reports nothing contrary (no public IP on the interface) → `lastmile`.
4. Otherwise → `unknown`.

**Only Core can earn `lastmile`.** Agent signals can only push a result to
`datacenter` or `unknown`, never to `lastmile` — so a modified agent can't dress a
server up as last mile (its IP still sits in a datacenter range or lacks access
evidence). Nobody gains by faking "datacenter", so trusting the agent in that
direction is safe. Disagreement means `unknown`, never a guess.

### Where it's computed and stored

- Reverse DNS and range checks are too slow for the claim transaction, so the
  location check computes access (register, IP change, and the existing
  `LOCATION_RECHECK_HOURS` cadence on heartbeat) and stores it on the agent:
  `eval_agents.access_class` + `access_reason` (system-only; never writable through
  any route). At claim, `buildJobTags` freezes it as a `detected` tag
  `access:<class>` (same transaction as today). Analyze jobs still get `[]`.
- Agent signals travel on register/heartbeat as `netSignals: { cloudMetadata, publicIpOnInterface }`
  (omitted when unknown). In a container the interface is a veth, so `vox-upgrade.sh`
  measures `publicIpOnInterface` on the host and passes `VOX_PUBLIC_IP_ON_IFACE`;
  the metadata probe works from inside a container (short timeout, once per beat
  at most every 10 minutes).
- Data: the datacenter range list and PeeringDB network types are downloaded and
  refreshed in-app weekly next to the GeoIP databases (`server/geoip-refresh.ts`
  pattern), stored under `GEOIP_DB_DIR`; missing data ⇒ fewer signals ⇒ more
  `unknown`, never a wrong `lastmile`. Licences of each list are checked before use
  and credited like DB-IP.
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

## `sim` is system-only — detected on both sides, must match (added 2026-10-22)

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
- **Limit:** both inputs reach Core through the agent. A modified agent could report
  a different real number plus a matching operator; Core's lookup is of a real number
  so it can't invent a carrier, but it can't prove which SIM is in the phone.
- Privacy: our number is stored redacted (last 4) on the agent; the full number lives
  only in the `number_lookups` cache key, as for `line`.

## Agent badge follows `access` (added 2026-10-22)

The Eval Agents page's location badge (zero-trust region: Verified / Verified ·
datacenter / Unverified) keeps meaning **location**, but its second word comes from
`access` instead of region trust's 12-ASN `datacenter` class:
**Verified · last mile**, **Verified · datacenter**, **Verified** (access unknown),
**Unverified**. One classification for both. Stored `location_trust` values are
values keep their names, but `datacenter` is now derived from `access` (see "Location
vs access") — no gating changes, since `trusted` and `datacenter` are handled alike.

## Out of scope (v1)

- A comparison page (side-by-side distributions per tag value) — v2 on this data.
- Native-app tags — the same keys apply when native testing lands.
- Tags on eval sets (a scenario isn't a network path).
