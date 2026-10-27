# Network Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the network path of every result as `key:value` tags (line provider, ISP, link type, SIM carrier, custom), freeze them per job, and let every metrics view filter and group by them.

**Architecture:** Hand-set tags live on eval flows and eval agents; the agent reports its link type on heartbeat; Core detects `isp` from the agent's IP (ASN DB) and `line` from a cached Twilio number lookup. At claim time both claim paths freeze flow + agent + detected tags into `eval_jobs.tags` with a source per tag; one shared `effectiveTags(jobTags, board)` decides which value each board uses. Metrics endpoints (console + v1) gain `tag=` and `groupBy=`.

**Tech Stack:** TypeScript, Express, Drizzle/PostgreSQL (hand-written migrations), React + TanStack Query + shadcn/ui, Vitest, Playwright.

**Spec:** `designs/2026-10-22-network-tags-design.md` — read it; it is the authority. This plan argues from it.

## Global Constraints

- Tag = `key:value`, both trimmed + lowercased, inner whitespace → `-`. Key `[a-z][a-z0-9-]{0,23}`, value `[a-z0-9][a-z0-9.\-]{0,47}`. Max **16** tags per flow/agent; one value per key (a later one replaces an earlier one).
- Known keys: `line`, `isp`, `link`, `sim`. `link` is a closed set: `wifi | ethernet | cellular | satellite`.
- Sources on frozen job tags: `flow`, `agent`, `detected`.
- Board rule: **mainline** uses the `detected` value for `line`/`isp`/`link`/`sim` (hand-set-only = untagged) — except `line` when the flow has no lookup answer, where the flow's hand-set `line` counts; other keys use the flow/agent value. **community / myEvals** use the hand-set value when present, else detected. One function, `effectiveTags`, in `shared/tags.ts`.
- `shared/tags.ts` is client-safe: no imports outside itself (it is imported by client, server and daemon).
- Number lookup: Twilio Lookup v2 `GET https://lookups.twilio.com/v2/PhoneNumbers/{E164}?Fields=line_type_intelligence`, Basic auth (Account SID : Auth Token). Cache per number **30 days**. Never look up a number held in a `${secrets.*}` placeholder. A failed lookup never blocks a save. No credentials → lookup off.
- Credentials stored encrypted in `systemConfig` (same pattern as the MaxMind key: `getMaxmindKey`, `PUT/DELETE /api/admin/geoip/maxmind-key` in `server/routes.ts` ~1182–1250). Admin routes live under `/api/admin`, exactly `requireAuth, requireAdmin` (`tests/admin-routes.test.ts` enforces this).
- `observed_ip` is never exposed on any endpoint.
- Migrations are hand-written, plain SQL (no `IF NOT EXISTS`), registered in `server/migrate.ts` `MIGRATIONS` (last is version 57, file `0056_eval_job_cancelled_by.sql`; next is version 58, file `0057_network_tags.sql`).
- No fake functionality; mocks/stubs only inside tests. Every rule gets a test that fails when the rule is removed (mutation-check).
- Integration tests hit the running dev server: after changing `server/`, `./scripts/dev-local-run.sh stop < /dev/null && ./scripts/dev-local-run.sh start < /dev/null`. Integration suites need `DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox"`.
- Before every commit: `npm run check` clean and the touched test files pass. Commit messages end with `🤖 Built with SMT <smt@agora.build>`.
- Match the surrounding code's style, comment density and naming.

---

### Task 1: `shared/tags.ts` — the tag model

**Files:**
- Create: `shared/tags.ts`
- Test: `tests/tags.test.ts`

**Interfaces (produces):**
```ts
export const KNOWN_TAG_KEYS = ["line", "isp", "link", "sim"] as const;
export const LINK_VALUES = ["wifi", "ethernet", "cellular", "satellite"] as const;
export const MAX_TAGS = 16;
export type TagSource = "flow" | "agent" | "detected";
export interface Tag { key: string; value: string }
export interface JobTag extends Tag { source: TagSource }
export type TagBoard = "mainline" | "community" | "myEvals";
export const TAG_SUGGESTIONS: Record<"line" | "isp" | "sim", string[]>;
export function normalizeTag(raw: string | Tag): Tag | { error: string };   // "Line : Twilio " → {key:"line",value:"twilio"}
export function parseTags(raw: unknown): { tags: Tag[] } | { error: string }; // array of strings or {key,value}; dedupe by key (last wins); cap MAX_TAGS; link closed set
export function formatTag(t: Tag): string;                                   // "line:twilio"
export function ispFromAsn(asn: number | undefined, org: string | undefined): string | undefined; // ASN map, else normalized org, else undefined
export function lineFromCarrier(carrierName: string | null | undefined): string | undefined;      // carrier-name map, else normalized name
export function isSatelliteIsp(isp: string | undefined): boolean;            // "starlink", other satellite ISPs in the map
export function effectiveTags(jobTags: JobTag[] | null | undefined, board: TagBoard, opts?: { flowHasLookup?: boolean }): Tag[];
export function parseTagFilter(raw: unknown): { filters: Tag[] } | { error: string }; // query `tag` (string | string[])
export function parseGroupBy(raw: unknown): { groupBy?: string } | { error: string };  // query `groupBy`, key syntax
```

- [ ] Write tests first, covering: normalization (case, spaces → `-`, trim), key/value syntax rejects, `link` closed set, 16 cap (17 → error), one value per key, `formatTag`, ASN map (14593→starlink, 7018→att, 7922→comcast, 701→verizon, 21928→t-mobile, 16509→aws, 15169→gcp, 8075→azure, unmapped → normalized org, nothing → undefined), carrier map ("Twilio - SMS/MMS-SVR"→twilio, "Bandwidth.com CLEC"→bandwidth, "Bandwidth/13 - Bandwidth.com - SVR"→bandwidth, "Telnyx"→telnyx, "Vonage"/"Nexmo"→vonage, "Plivo"→plivo, "Sinch"→sinch, "SignalWire"→signalwire, unmapped → normalized, null → undefined), satellite inference, `effectiveTags` per board (mainline: detected `isp` wins, hand-set-only `isp` dropped; flow `line` kept only when `flowHasLookup` is false; community/myEvals: agent's hand-set `isp` wins over detected; custom keys always from flow/agent, agent overriding flow for the same custom key), `parseTagFilter` (single, repeated, invalid → error), `parseGroupBy`.
- [ ] Run `npx vitest run tests/tags.test.ts` — fails (module missing).
- [ ] Implement `shared/tags.ts`, self-contained.
- [ ] Tests pass; `npm run check` clean; mutation-check two rules (e.g. the link closed set, the mainline detected rule).
- [ ] Commit.

### Task 2: Schema, migration, snapshot

**Files:**
- Modify: `shared/schema.ts` (`evalFlows`, `evalAgents`, `evalJobs`, new `numberLookups`; insert/select schemas; `JobSnapshot` type if declared there)
- Create: `migrations/0057_network_tags.sql`
- Modify: `server/migrate.ts` (register version 58)
- Modify: `server/storage.ts` `buildJobSnapshot()` (snapshot `evalFlow.tags` and `evalFlow.lineLookup`)
- Test: `tests/network-tags-schema.test.ts` (migration applied: columns exist with the right defaults; `buildJobSnapshot` carries flow tags + lineLookup)

**Columns:**
- `eval_flows.tags jsonb NOT NULL DEFAULT '[]'`, `eval_flows.line_lookup jsonb` (null = none; shape `{ value, carrierName, lineType, lookedUpAt, number }` — number stored redacted to last 4 digits).
- `eval_agents.tags jsonb NOT NULL DEFAULT '[]'`, `eval_agents.link_type varchar(16)`.
- `eval_jobs.tags jsonb` (null for jobs claimed before the release).
- `number_lookups`: `number varchar(20) PRIMARY KEY` (E.164), `provider varchar(16) NOT NULL`, `carrier_name text`, `line_type varchar(32)`, `value varchar(48)`, `looked_up_at timestamp NOT NULL DEFAULT now()`.

- [ ] Test first, then schema + SQL + registration + snapshot. Apply on the dev DB with the runner (`npx tsx server/migrate.ts`) — never `db:push` on a runner-managed DB.
- [ ] `npm run check`, test passes, commit.

### Task 3: Hand-set tags and link type through the API

**Files:**
- Modify: `server/routes.ts` — `POST /api/eval-flows` (~2218), `PATCH /api/eval-flows/:id` (~2289): accept `tags`, validate with `parseTags` (400 with its error); `GET` flow responses include `tags` and `lineLookup`.
- Modify: `server/routes.ts` — new `PATCH /api/eval-agents/:id/tags` (session auth; only the agent token's creator may set; others 403; admin is NOT an editor — permission model); `GET /api/eval-agents` (~4015) includes `tags` and `linkType` (never `observedIp`).
- Modify: `server/routes.ts` — `POST /api/eval-agent/register` (~4141) and `/heartbeat` (~4250): accept optional `linkType` (must be in `LINK_VALUES`, else ignored with no error so old/new agents interoperate; absent leaves the stored value; `null` clears), stored on `eval_agents.link_type`.
- Modify: `server/routes-api-v1.ts` — v1 flow create/update (if it exists) accepts/returns `tags` the same way.
- Modify: `server/storage.ts` — storage methods as needed.
- Modify: `docs/openapi.yaml` — `tags` on flow schemas (v1 only).
- Test: `tests/network-tags-api.test.ts` (integration): flow tags saved normalized; invalid → 400; non-editor PATCH → 403; agent tags only by its operator; heartbeat `linkType` stored, invalid ignored, `null` clears; `GET /api/eval-agents` exposes tags/linkType, not observed IP.

- [ ] Test first; implement; restart dev; tests pass; mutation-check the agent-operator rule; commit.

### Task 4: Freeze tags at claim

**Files:**
- Modify: `server/storage.ts` — `claimEvalJob` (~1381, sets `location_trust` ~1444) and the second claim path (`getClaimableJobsForToken` ~1459 and whatever finalizes that claim): write `eval_jobs.tags` in the same UPDATE.
- Create: `server/job-tags.ts` — `buildJobTags({ snapshotFlow, agent: { tags, linkType, observedIp } }): JobTag[]`:
  - flow hand-set tags (from the job's snapshot `evalFlow.tags`) → source `flow`;
  - `line` from snapshot `evalFlow.lineLookup.value` → source `detected`;
  - agent hand-set tags → source `agent`;
  - `isp` from `observedIp` via the ASN reader in `server/location.ts` + `ispFromAsn` → `detected`;
  - `link` from `linkType` → `detected`; if absent and `isSatelliteIsp(isp)` → `link:satellite` detected.
- Test: `tests/network-tags-claim.test.ts` (integration; both claim paths): job tags contain all sources; editing flow/agent tags after claim doesn't change the job; agent without IP/ASN → no detected isp; satellite inference; unit tests for `buildJobTags` with an injected ASN lookup.

- [ ] Test first; implement; restart dev; tests pass; mutation-check (drop the agent source → fails); commit.

### Task 5: Twilio number lookup

**Files:**
- Create: `server/number-lookup.ts` — `NumberLookupProvider` interface; `TwilioLookupProvider` (fetch with timeout 10 s; base URL overridable only via an injected option for tests); `lookupFlowLine(flow)`: extract the dialled number from the flow's `call.dial` Setup step (use the existing steps helpers in `shared/steps.ts`), resolve `${config.*}` from the flow's own config, skip `${secrets.*}` (returns reason `secret`), normalize to E.164, read cache (`number_lookups`, < 30 days) else call provider and upsert; map with `lineFromCarrier`; return `{ value, carrierName, lineType, lookedUpAt, number(redacted) }` or `{ skipped: "not-configured" | "secret" | "no-number" | "no-carrier" | "failed" }`.
- Modify: `server/routes.ts` — after a phone flow create/patch commits (only when transport is phone and the dialled number changed or there's no lookup yet), run the lookup **without blocking the response's success** (await with the 10 s timeout, catch everything; store `line_lookup` on success); `POST /api/eval-flows/:id/line-lookup` ("Look up again", flow editors only); admin `GET/PUT/DELETE /api/admin/number-lookup/twilio` (credentials encrypted in `systemConfig`, `GET` shows `configured` + masked SID only).
- Modify: `server/sensitive-paths.ts` — exclude the credential PUT from request logs (its test scans routes).
- Test: `tests/number-lookup.test.ts` — a real HTTP stub server in the test (Twilio response shapes from the spec) injected via the provider's base-URL option: mapping, cache hit within 30 days (no second HTTP call), refresh after, `${secrets.*}` never sent, toll-free (null carrier) → `no-carrier`, HTTP 500 → `failed` and the flow still saves, no credentials → `not-configured`; admin routes admin-only.

- [ ] Test first; implement; restart dev; tests pass; mutation-check the secret skip; commit.

### Task 6: Metrics — `tag=` and `groupBy=`

**Files:**
- Modify: `server/metrics-params.ts` — re-export/use `parseTagFilter`, `parseGroupBy`.
- Modify: `server/storage.ts` — `getTierEvalResults` (and console variants) accept `tagFilters`: SQL predicate on `eval_jobs.tags` implementing `effectiveTags` for the board (write it once, commented, mirroring the shared function; a unit test feeds the same fixtures to both). Results expose the job's tags so routes can group.
- Modify: `server/routes.ts` — `/api/metrics/realtime` (~6056), `/community` (~6078), `/my-evals` (~6100), `/leaderboard` (~6195): parse `tag`/`groupBy` (400 on error), add both to cache keys, rows carry `tags` (effective), leaderboard groups provider × site × groupBy value (`untagged` bucket).
- Modify: `server/routes-api-v1.ts` — same parameters on `/api/v1/metrics/realtime` and `/leaderboard`; `meta` echoes `tag` and `groupBy`.
- Modify: `docs/openapi.yaml` — parameters + row `tags` + meta fields.
- Test: `tests/network-tags-metrics.test.ts` (integration, own backdated provider as in `tests/v1-metrics-tiers.test.ts`): filter per board (mainline ignores hand-set-only isp; community honors it), multiple filters AND, groupBy with untagged bucket, v1 parity, 400s, cache key separation.

- [ ] Test first; implement; restart dev; tests pass; mutation-check the mainline rule in SQL; commit.

### Task 7: Agent — link detection

**Files:**
- Create: `vox_eval_agentd/link-type.ts` — `detectLinkType({ env, platform, sysRoot, exec }): LinkType | undefined`: `VOX_LINK_TYPE` (valid value) wins; Linux: default-route interface (`ip route get 1.1.1.1` → `dev X`), `/sys/class/net/X/wireless` exists → wifi, name `wwan*` or `/sys/class/net/X/device/driver` resolves to `qmi_wwan|cdc_mbim|cdc_ether` → cellular, else ethernet; macOS: `route get default` interface + `networksetup -listallhardwareports` (Wi-Fi port → wifi, else ethernet); failure → undefined.
- Modify: `vox_eval_agentd/vox-agentd.ts` — send `linkType` on register and heartbeat (alongside `capabilities`), refreshed every beat.
- Modify: `scripts/vox-upgrade.sh` — detect the host's link type the same way (bash) and pass `-e VOX_LINK_TYPE=<value>` when known; keep existing behavior otherwise (`tests/vox-upgrade-dialf.test.ts` must still pass).
- Modify: `vox_eval_agentd/Dockerfile` only if a new file needs a `COPY` (check how other daemon files are copied).
- Test: `tests/link-type.test.ts` — fake `/sys` tree in a temp dir + fake exec: wifi, cellular (wwan name, qmi driver), ethernet, env override, invalid env ignored, failure → undefined; a vox-upgrade test case asserting `VOX_LINK_TYPE` is passed.

- [ ] Test first; implement; tests pass; if Dockerfile touched, run a real local build (`docker build -f vox_eval_agentd/Dockerfile .`); commit.

### Task 8: Console UI

**Files:**
- Create: `client/src/components/tag-input.tsx` — chips input using `parseTags`/`normalizeTag` + `TAG_SUGGESTIONS`; known keys suggested first; `link` offers only its four values.
- Modify: the eval flow form (find it under `client/src/pages/` — the create/edit eval flow page) — Tags field; phone flows show the lookup answer ("Line provider: bandwidth — looked up <date>, <lineType>") with "Look up again", or the skip reason in plain words.
- Modify: the Agents page — tags column: detected `isp`/`link` (marked "detected") and hand-set tags (editable by the agent's operator — follow the server's ownership flag; add a `canEditTags` flag to `GET /api/eval-agents` rows server-side if none exists, so the UI never offers a 403).
- Modify: Leaderboard, Community, My Evals pages — tag filter chips + "Group by" select (known keys first); grouped rows show the tag value.
- Modify: job detail page — the job's tags with source.
- Modify: the admin Regions page (where the MaxMind key is managed) — Twilio Lookup credentials card (set/replace/remove, masked SID).
- Test: `tests/e2e/network-tags.spec.ts` — tag a flow, see it saved; filter + group the leaderboard by a tag via URL/controls on seeded data; admin card renders. Keep within existing E2E budgets.

- [ ] Implement; `npm run check`, `npm run lint`; screenshot each changed page with Playwright and look at it; E2E passes; commit.

### Task 9: Docs

**Files:**
- Modify: `CLAUDE.md` (Architecture: tags model, board rule, lookup), `docs/DEPLOYMENT.md` (Twilio Lookup credentials in console; `VOX_LINK_TYPE`), `client/src/pages/api-docs.tsx` (one sentence + example `tag=`/`groupBy=` in step 5), `README.md` metrics rows (`tag`, `groupBy`).
- [ ] Edit; `npm run check`; commit.
