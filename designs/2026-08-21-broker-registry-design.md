# Broker Registry Redesign — Design Spec

**Date:** 2026-08-21
**Status:** Draft for review
**Author:** (brainstorming session)
**Supersedes addressing model of:** `designs/2026-08-21-aeval-base-broker-split-design.md` (broker addressing only — the base/daemon image split stands)

---

## 1. Context

Today Core mints login sessions (`storageState`) for web eval targets by driving a single **session broker** sidecar. Two things are hardcoded:

1. **The secret class.** A secret is `runtime` (exposed to agents) or `protected` (Core-only, materialized into an ephemeral `storageState`). This is a fixed two-value enum (`secret_class` at `shared/schema.ts:19`), and the "protected → login session" mapping is implicit in the code, not data.

2. **The broker address.** Core reaches the broker through `SESSION_BROKER_URL` + `SESSION_BROKER_SECRET` env vars — one broker, one URL, set by hand in Coolify. There is no registry, no health/state visibility, and no way to run a second broker or a different *kind* of broker without new env plumbing and a redeploy.

The class model is really a special case of a general pattern: **a permanent secret stays in Core; a broker of some type materializes an ephemeral artifact from it; the agent consumes only the artifact.** Login (email/password → `storageState`) is the first instance. A hypothetical "OpenAI-key broker" (permanent key in Core → short-lived scoped key to the agent) would be a second. The current enum can't express "which broker type materializes this secret," so it can't grow.

This redesign generalizes both: **secrets reference a broker *type* by name; brokers *register themselves* with Core at deploy time and appear in an admin-visible registry; Core routes a materialization request to a healthy broker instance of the referenced type.**

Only **one real broker type is built end to end: `auth-session`** (the renamed login broker). The generalized shape is laid down as foundation; no second type (e.g. OpenAI key) is implemented.

### Locked decisions (from brainstorming, 2026-08-21)

- Replace the `class` enum with a nullable **`brokerType`** text reference. `null` = runtime (exposed to agents); a non-null value names the broker type that materializes the secret (agent never sees the permanent value).
- **Name-based default at creation:** a secret whose name matches `/USERNAME|PASSWORD|ACCOUNT|EMAIL/i` defaults `brokerType = "auth-session"`; the creator may override. **UX sugar only — not a security control.**
- **Rename** `session-broker` → `auth-session-broker` across DB, code, and docs.
- **Dynamic registry:** brokers self-register with Core; the hardcoded `SESSION_BROKER_URL` addressing is retired.
- **Trust model — operator-only infra:** admin-issued registration tokens (hashed), internal-network-only advertised URLs, a per-broker mint secret generated at registration. Core rejects a non-internal advertised URL.
- **Scope — all-in-one** (schema + rename + registry in one effort), but only `auth-session` is a working broker type end to end. The OpenAI-key broker is **not** built.
- **No backward compatibility** required.
- **Judgment calls approved:** (1) `brokerType` is free text, server-validated against a known-types set — not a Postgres enum, so a new type needs no migration; (2) split Core's `server/session-broker.ts` into `server/broker-registry.ts` (generic registry + routing) and `server/auth-session.ts` (login-specific requirement/scope/mint logic); (3) broker region-awareness is out of scope — routing picks any healthy broker of the type.

---

## 2. Goals / Non-Goals

**Goals**

- Secrets carry a `brokerType` reference instead of a `runtime|protected` class.
- One known broker type, `auth-session`, is server-validated and fully wired.
- Brokers register with Core (hashed admin-issued token), heartbeat, and appear in an admin registry list with health/state.
- Core routes a mint to a healthy `auth-session` broker instance via the registry, replacing `SESSION_BROKER_URL`.
- A per-broker mint secret authenticates Core → broker `/mint` (no shared global secret).
- Core rejects registration from a broker advertising a non-internal URL.
- Names, DB objects, code files, and docs consistently say `auth-session` / `auth-session-broker`.

**Non-Goals**

- No second broker type (OpenAI key or otherwise) is implemented. The type set has exactly one member.
- No broker region-awareness / geo-routing. Any healthy instance of the type serves.
- No public-network broker support. Internal-only remains a structural invariant.
- No migration of existing `protected` production data beyond the one-time class→brokerType backfill (there is no protected-class secret in production yet — deployment was proactive).
- No change to how agents consume the artifact: they still fetch a pre-minted `storageState` from `GET /api/eval-agent/jobs/:jobId/session` and run `setup:storage`.

---

## 3. Section A — Secret model: `class` enum → `brokerType` reference

### A.1 Schema

Drop the `secret_class` enum and both `class` columns; add a nullable `brokerType` text column to `secrets` and `orgSecrets`.

`shared/schema.ts`:

- **Remove** `export const secretClassEnum = pgEnum("secret_class", ["runtime", "protected"])` (line 19).
- **`secrets`** (line 676): replace
  `class: secretClassEnum("class").default("runtime").notNull()`
  with
  `brokerType: text("broker_type")` — nullable, no default (null = runtime).
- **`orgSecrets`** (line 465): same replacement on `class` (line 472).
- `isTestAccount` stays unchanged on both tables (still the shared-tier attestation flag).

Rationale for text-not-enum: adding a broker type must not require a schema migration. Validation lives in code (A.3).

### A.2 Known broker types (server-validated)

A single source of truth in Core:

```ts
// server/broker-registry.ts
export const KNOWN_BROKER_TYPES = ["auth-session"] as const;
export type BrokerType = (typeof KNOWN_BROKER_TYPES)[number];
export function isKnownBrokerType(v: unknown): v is BrokerType {
  return typeof v === "string" && (KNOWN_BROKER_TYPES as readonly string[]).includes(v);
}
```

A secret's `brokerType` is either `null` (runtime) or a member of `KNOWN_BROKER_TYPES`. Any other value is rejected at the API boundary.

### A.3 Secret create/update API

`POST /api/secrets` (`server/routes.ts:2450`) and `POST /api/org-secrets` (`:2543`):

- Replace the `secretClass` param handling (`:2472-2475`) with a `brokerType` param:
  - `brokerType === undefined` → apply the **name-based default** (A.4).
  - `brokerType === null` or `""` → store `null` (runtime).
  - `brokerType` a known type → store it.
  - otherwise → `400 { error: "Unknown brokerType" }`.
- Replace the reclassification guard (`:2486-2488`). New rule, same intent — **a brokered secret cannot be silently downgraded to runtime**: if an existing row has a non-null `brokerType` and the request would set it to `null`/runtime, return
  `400 { error: "A brokered secret cannot be reclassified to runtime — delete and recreate it instead" }`.
  Changing from one broker type to another is likewise rejected with the same delete-and-recreate guidance (there is only one type today, so this is forward-guarding).
- Response `class` field becomes `brokerType`. `GET` listings (`/api/secrets`, `/api/org-secrets:2529`) return `brokerType` instead of `class`.

### A.4 Name-based default (UX sugar)

```ts
// server/auth-session.ts
const AUTH_SESSION_NAME_RE = /USERNAME|PASSWORD|ACCOUNT|EMAIL/i;
export function defaultBrokerTypeForName(name: string): BrokerType | null {
  return AUTH_SESSION_NAME_RE.test(name) ? "auth-session" : null;
}
```

Applied only when the create request omits `brokerType`. It is a **convenience default, not an enforcement boundary** — a user may create a `MY_PASSWORD` secret as runtime by explicitly sending `brokerType: null`, and may mark any secret `auth-session`. The security guarantees (A.5, both-or-neither) do not depend on the name heuristic.

### A.5 Materialization gate (was: protected → Core-only)

The invariant is unchanged in substance, retargeted from `class === "protected"` to `brokerType != null`:

- **Job-secrets path** (`server/routes.ts` `getSecretsForJob`): a secret with a non-null `brokerType` is **structurally excluded** from the secrets handed to any agent, at every dispatch tier. Its permanent value never leaves Core.
- **`getProtectedSecretNames(scope)`** (in `server/session-broker.ts` today, filters `s.class === "protected"`) becomes **`getBrokeredSecretNames(scope, brokerType)`** in `server/auth-session.ts` — filters `s.brokerType === "auth-session"` for the auth-session path. (Generic registry code never needs the "any brokered" set for this slice; only auth-session consumes it.)
- **Both-or-neither rule** (`evaluateSessionRequirement`, moving to `server/auth-session.ts`): a workflow's `platform.setup` email+password refs must **both** resolve to `auth-session` secrets or the job is `misconfigured`. A split pair (one brokered, one runtime) is rejected, never half-served — unchanged logic, retargeted predicate.

### A.6 `sessionInjection` trigger (unchanged shape)

Job creation still stamps `config.sessionInjection = { platformId }` when the workflow references an `auth-session` secret via `platform.setup`. The trigger is the secret's broker type (now `brokerType === "auth-session"`), not the dispatch tier — any tier (team/private/public/shared) that references a brokered login secret is stamped. Call sites unchanged: `stampOwnerSession` at `routes.ts:2346` and `index.ts:408`.

---

## 4. Section B — Broker registry

Modeled directly on the eval-agent token + agent registration pair (`evalAgentTokens` / `evalAgents`, `shared/schema.ts:205`/`:229`; register/heartbeat handlers `routes.ts:2945`/`:3021`).

### B.1 Schema — two new tables

**`brokerRegistrationTokens`** — admin-issued, hashed, mirrors `evalAgentTokens`:

```ts
export const brokerRegistrationTokens = pgTable("broker_registration_tokens", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  brokerType: text("broker_type").notNull(),      // which type this token may register
  createdBy: integer("created_by").notNull().references(() => users.id),
  isRevoked: boolean("is_revoked").default(false).notNull(),
  expiresAt: timestamp("expires_at"),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**`brokers`** — the live registry, mirrors `evalAgents`:

```ts
export const brokers = pgTable("brokers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tokenId: integer("token_id").notNull().references(() => brokerRegistrationTokens.id),
  brokerType: text("broker_type").notNull(),
  // Internal advertised base URL Core POSTs /mint to (e.g. http://vox-auth-session-broker:8200).
  url: text("url").notNull(),
  // Per-broker mint secret (hashed). Core presents the plaintext (held in memory only
  // at registration return) as Bearer on /mint; the broker verifies against this hash.
  mintSecretHash: text("mint_secret_hash").notNull(),
  state: brokerStateEnum("state").default("offline").notNull(),   // idle | offline | busy
  currentLeaseId: text("current_lease_id"),
  lastSeenAt: timestamp("last_seen_at"),
  observedIp: text("observed_ip"),
  observedIpAt: timestamp("observed_ip_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

New enum `brokerStateEnum = pgEnum("broker_state", ["idle", "offline", "busy"])`.

> **Mint-secret handedness.** The per-broker mint secret is *generated by Core at registration* and returned once to the broker in the register response (Core stores only its hash). This inverts the current global `SESSION_BROKER_SECRET` (operator sets it on both sides). It means only a broker that completed a registration handshake can be minted to, and revoking the broker row invalidates the secret. See B.4.

### B.2 Internal-URL guard

Core rejects a registration whose advertised `url` host is not internal. A broker sits on the internal Coolify network; a public/routable advertised URL is a misconfiguration or an attack.

```ts
// server/broker-registry.ts
export function isInternalBrokerUrl(raw: string): boolean {
  // Accept only http on a private/internal host: RFC1918, loopback, .internal,
  // or a Docker/Coolify network alias (no dots, single-label DNS).
  // Reject https-public, public IPs, and any host with a public TLD.
}
```

Exact predicate: parse the URL; require `http:` scheme; host must be one of — loopback (`127.0.0.0/8`, `::1`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), a single-label hostname (Docker/Coolify network alias, e.g. `vox-auth-session-broker`), or a `*.internal` / `*.local` suffix. Anything else → reject with `400 { error: "Broker URL must be internal" }`. Registration is refused; the broker does not enter the registry.

### B.3 Endpoints

Admin token management (mirror `/api/admin/eval-agent-tokens`, `requireAdmin`):

- `GET /api/admin/broker-tokens` — list registration tokens (hashed; never returns plaintext).
- `POST /api/admin/broker-tokens` — create a registration token for a given `brokerType` (validated against `KNOWN_BROKER_TYPES`). Returns the plaintext **once**.
- `POST /api/admin/broker-tokens/:id/revoke` — revoke.
- `GET /api/admin/brokers` — list registered brokers with state/health/lastSeen/type/url. `observedIp` is **not** surfaced (Core-internal, same rule as `eval_agents.observed_ip`). This is the admin "brokers list" the user asked for.

Broker self-service (Bearer = registration token, mirror `/api/eval-agent/register` + `/heartbeat`):

- `POST /api/brokers/register` — body `{ name, url, brokerType }`.
  1. Bearer must hash to a live, non-revoked, non-expired `brokerRegistrationTokens` row.
  2. `brokerType` in body must equal the token's `brokerType` and be known.
  3. `url` must pass `isInternalBrokerUrl` (B.2).
  4. Generate a fresh per-broker **mint secret** and a **lease id**; upsert the `brokers` row by `tokenId` (reuse on re-register, like eval-agent upsert at `routes.ts:2980`), store `mintSecretHash`, set `state: "idle"`, stamp `observedIp` from `req.ip`.
  5. Return `{ id, brokerType, leaseId, mintSecret }` — `mintSecret` plaintext returned exactly once.
- `POST /api/brokers/heartbeat` — body `{ brokerId, state?, leaseId }`. Lease-fenced exactly like eval-agent heartbeat (`isSupersededLease`, `:3046`). Updates `lastSeenAt`, `observedIp`. Returns `{ superseded: true }` for a stale lease, or `{ reregister: true }` when the broker row exists but Core holds no cached mint secret for it (cold cache after a Core restart — B.4). A broker not heartbeating within the offline window is treated as `offline` by routing (B.5).

### B.4 Mint authentication (Core → broker)

- At mint time Core presents `Bearer <mintSecret>` to the target broker. Core **generates** the mint secret while handling `/api/brokers/register`, returns the plaintext to the broker once, stores only `mintSecretHash`, and **caches the plaintext in memory** keyed by broker id. This is the same posture as `SESSION_BROKER_SECRET` today (a process-memory secret), but per-broker and rotate-on-reregister. No plaintext mint secret is ever persisted.
- **Cold-cache recovery (self-healing).** On a Core restart the in-memory cache is empty, but the broker rows and their hashes survive in Postgres. A broker keeps heartbeating with its existing lease, unaware Core restarted. So the **heartbeat handler signals re-registration** whenever the broker row exists but Core holds no cached mint secret for it: it responds `{ reregister: true }` (parallel to the `superseded` signal). The broker reacts by calling `/api/brokers/register` again, which generates a **fresh** mint secret and repopulates the cache. Until it re-registers, Core has no cached secret for that broker and routing treats it as **ineligible** (B.5) — so no mint is ever attempted with a stale/absent secret.

> **Design note (call out for review):** the in-memory mint-secret cache is the one piece of runtime state that isn't in Postgres. The alternative — encrypt-at-rest the mint secret with `CREDENTIAL_ENCRYPTION_KEY` and decrypt at mint time — removes the cold-cache-after-restart gap at the cost of storing a reversible broker credential. The spec chooses in-memory (no reversible broker credential at rest, self-healing via re-register). Flag if you prefer the encrypted-at-rest variant.

### B.5 Routing

Core replaces "read `SESSION_BROKER_URL`" with "pick a healthy broker of the type":

```ts
// server/broker-registry.ts
export async function routeToBroker(brokerType: BrokerType): Promise<BrokerTarget | null>;
```

A broker is **eligible** iff: `brokerType` matches, `state === "idle"`, `lastSeenAt` within the offline window (reuse the eval-agent heartbeat staleness constant), and Core holds a cached mint secret for it (B.4). Among eligible brokers, pick any (e.g. least-recently-used or random — no region preference). If none, the mint fails the same way a broker-down failure fails today: the session endpoint returns `503 failed`, and the job is failed **before** any eval runs (escrow-refund path for shared-tier, unchanged).

`brokerConfigured()` (today `!!SESSION_BROKER_URL && !!SESSION_BROKER_SECRET`) becomes **`await brokerAvailable(brokerType)`** — true iff `routeToBroker` would return a target. Call sites that gate on broker presence switch to this.

---

## 5. Section C — `auth-session-broker` service

The sidecar (`vox_eval_agentd/session-broker.ts`, renamed `auth-session-broker.ts`) gains a registration client and per-broker mint auth; it retires the global `SESSION_BROKER_SECRET` / `SESSION_BROKER_URL` model.

### C.1 Registration client (new)

On startup the broker:

1. Reads `BROKER_REGISTRATION_TOKEN`, `CORE_URL`, `BROKER_ADVERTISE_URL` (its own internal URL, e.g. `http://vox-auth-session-broker:8200`), `BROKER_TYPE` (default `auth-session`), `BROKER_PORT` (default 8200).
2. `POST ${CORE_URL}/api/brokers/register` with `Bearer BROKER_REGISTRATION_TOKEN`, body `{ name, url: BROKER_ADVERTISE_URL, brokerType: BROKER_TYPE }`.
3. Stores the returned `brokerId`, `leaseId`, and `mintSecret` **in memory**.
4. Heartbeats `POST ${CORE_URL}/api/brokers/heartbeat` on an interval (reuse the daemon's heartbeat cadence), carrying `brokerId` + `leaseId`.
5. On a `superseded` heartbeat response, re-registers (fresh lease), like the daemon.
6. On a `{ reregister: true }` heartbeat response (Core lost its in-memory mint-secret cache, e.g. after a Core restart — B.4), re-registers to obtain a fresh mint secret and repopulate Core's cache.

If registration fails at boot, the broker retries with backoff; it serves `/health` (200) throughout so its container stays up, but it will not receive mints until registered (Core won't route to an unregistered broker).

### C.2 `/mint` auth change

`/mint` (in `createBrokerServer`, `session-broker.ts:119`) currently checks `secretMatches(presented, deps.secret)` against the single global secret. It now checks against the **per-broker mint secret** issued at registration (held in memory). The constant-time `secretMatches` and credential-scrubbing (`scrubCredentials`) helpers are unchanged. `GET /health` stays a plain 200 (no auth) for the container health check.

### C.3 Mint body unchanged

`POST /mint` body stays `{ platformId, email, password }` → `{ storageState }`. `mintWithAeval` (the `setup:account` → `save_storage_state` scenario) is unchanged. Only *who authenticates* and *how the broker is addressed* change.

### C.4 Retired env vars

- **Removed from Core:** `SESSION_BROKER_URL`, `SESSION_BROKER_SECRET`.
- **Removed from broker:** `SESSION_BROKER_SECRET`.
- **New on broker:** `BROKER_REGISTRATION_TOKEN`, `CORE_URL`, `BROKER_ADVERTISE_URL`, `BROKER_TYPE` (optional, default `auth-session`).
- `WEB_SESSION_MINT_TIMEOUT_SECONDS`, `BROKER_PORT` retained.

Coolify follow-up (out of code scope, tracked in ledger): issue an admin broker-registration token, set the four new broker env vars on the `vox-auth-session-broker` app, remove the two retired Core env vars. Deployment steps mirror the completed 2026-08-21 broker deploy.

---

## 6. Section D — Rename map (`session-broker` → `auth-session-broker`)

No backward compatibility. Rename in one pass.

**Database**
- Column `secrets.class` → `secrets.broker_type` (type change: enum→text, drop enum). Same for `org_secrets`.
- Enum `secret_class` — dropped.
- New tables `broker_registration_tokens`, `brokers`; new enum `broker_state`.
- (No table named `session_broker` exists today, so nothing to rename there; `web_sessions` keeps its name — it stores the minted artifact, not the broker.)

**Code — Core**
- `server/session-broker.ts` → **split** into:
  - `server/broker-registry.ts` — `KNOWN_BROKER_TYPES`, `isKnownBrokerType`, `isInternalBrokerUrl`, registry storage calls, `routeToBroker`, `brokerAvailable`, generic mint dispatch (`mintViaBroker` retargeted to a routed target + per-broker secret).
  - `server/auth-session.ts` — login-specific: `parsePlatformSetup`, `sessionScopeForWorkflow`, `credentialKeyFor`, `evaluateSessionRequirement`, `getBrokeredSecretNames`, `stampOwnerSession`, `defaultBrokerTypeForName`, `ensureSession`.
- Update imports at call sites: `routes.ts` (`stampOwnerSession:2346`, `evaluateSessionRequirement:3717`, session endpoint `:3569`), `index.ts` (`stampOwnerSession:408`), `routes-api-v1.ts` (`evaluateSessionRequirement:329`).
- `getProtectedSecretNames` → `getBrokeredSecretNames`; `brokerConfigured` → `brokerAvailable`.
- Storage methods (`server/storage.ts`): add broker-token + broker CRUD mirroring eval-agent-token/agent methods (`createBrokerRegistrationToken`, `getBrokerRegistrationTokenByHash`, `createBroker`, `getBrokersByTokenId`, `updateBrokerHeartbeat`, `updateBrokerObservedIp`, `listBrokers`, `routeEligibleBrokers`, …).

**Code — broker service / daemon**
- `vox_eval_agentd/session-broker.ts` → `vox_eval_agentd/auth-session-broker.ts`. Update the entrypoint guard (`process.argv[1].endsWith('session-broker.js')` → `'auth-session-broker.js'`).
- `Dockerfile` broker target: rename the built entrypoint reference; image name `vox-session-broker` → `vox-auth-session-broker`.
- `docker.yml` / compose: image + target + smoke-test names `vox-session-broker` → `vox-auth-session-broker`.
- Any tests importing the broker file (`tests/session-broker-service.test.ts` → `tests/auth-session-broker-service.test.ts`) update path + name.

**Docs**
- `CLAUDE.md` "Session Broker" subsection → "Auth-Session Broker"; env-var table; broker-image name; the `class: "protected"` language → `brokerType: "auth-session"`; describe the registry (register/heartbeat, admin list) replacing `SESSION_BROKER_URL`.
- `plugins/shared-agents/SPEC.md` and any design docs referencing `SESSION_BROKER_URL` / protected-class — update terminology.

---

## 7. Section E — Migration

One new migration, version **31**, file `migrations/0030_broker_registry.sql`, registered in the `MIGRATIONS` array in `server/migrate.ts` (append after version 30 `0029_secret_class_protected.sql`; `TARGET_VERSION` auto-derives). Plain SQL only — no `IF NOT EXISTS`, no `DO`/`EXCEPTION`.

Order of operations:

1. `ALTER TABLE secrets ADD COLUMN broker_type text;`
2. `ALTER TABLE org_secrets ADD COLUMN broker_type text;`
3. Backfill: `UPDATE secrets SET broker_type = 'auth-session' WHERE class = 'protected';` and the same for `org_secrets`. (`runtime` rows → `broker_type` stays null.)
4. `ALTER TABLE secrets DROP COLUMN class;` and `org_secrets` likewise.
5. `DROP TYPE secret_class;`
6. `CREATE TYPE broker_state AS ENUM ('idle', 'offline', 'busy');`
7. `CREATE TABLE broker_registration_tokens (...);`
8. `CREATE TABLE brokers (...);`
9. Indexes: unique on `broker_registration_tokens.token_hash`; index `brokers(token_id)`; index `brokers(broker_type, state)` for routing.

Because production currently has **no** `protected`-class secret (the broker deploy was proactive), step 3 backfills zero rows in prod today — but it is correct if any were added before this ships. Local dev DBs with `protected` secrets are handled by the same backfill. `db:push` (local dev) reflects the schema.ts changes directly; the migration is the production path.

---

## 8. Section F — Scope boundary

**Built end to end (this effort):**
- `brokerType` secret model + name-default + materialization gate retargeting.
- `auth-session` as the single known, validated broker type.
- Broker registry: tables, admin token endpoints, register/heartbeat, admin list, internal-URL guard, per-broker mint secret, type-based routing.
- `auth-session-broker` service: registration client, per-broker `/mint` auth, retired global env.
- Full rename across DB/code/docs.
- Migration 0030.

**Foundation only (NOT built):**
- Any second broker type (OpenAI key or otherwise). `KNOWN_BROKER_TYPES` has one member. Adding a type later = add to the set + a broker service that registers with that type; **no schema migration** needed (brokerType is text).
- Broker region-awareness / geo-routing.
- Encrypted-at-rest mint secret (B.4 design note) — deferred unless review prefers it.

---

## 9. Testing

- **Unit — secret model:** name-default (`defaultBrokerTypeForName`), create/update API brokerType validation (unknown → 400), reclassification guard (brokered→runtime 400), materialization gate (`getBrokeredSecretNames` filters brokerType), both-or-neither (`evaluateSessionRequirement` misconfigured on split pair).
- **Unit — registry:** `isInternalBrokerUrl` (accept RFC1918/loopback/single-label/`.internal`; reject public IP, https-public, public TLD), `isKnownBrokerType`, `routeToBroker` eligibility (type match + idle + fresh heartbeat + cached mint secret), `brokerAvailable`.
- **Unit — broker service:** registration client (register→store lease+secret, heartbeat, superseded→re-register), `/mint` per-broker-secret auth (constant-time, wrong secret → 401), `scrubCredentials` unchanged.
- **Integration:** admin issues broker token → broker registers (internal URL ok, public URL rejected) → appears in `GET /api/admin/brokers` → Core routes a mint to it → session endpoint state machine (`ready`/`minting`/`failed`) unchanged.
- **Migration:** apply 0030 on a DB with a `protected` secret → `broker_type = 'auth-session'`, `class` gone, enum dropped, new tables present.
- **Docker:** real repo-root build (`-f vox_eval_agentd/Dockerfile`, context `.`) of the renamed `vox-auth-session-broker` target; broker `/health` → 200. (Matches CI; per docker-build-verification memory.)
- Rename sweep: `grep -ri 'session.broker\|secret_class\|SESSION_BROKER_' ` returns only intended historical references (none in live code).

---

## 10. Follow-up (out of scope, tracked in ledger)

- Coolify: issue admin broker-registration token; set broker env (`BROKER_REGISTRATION_TOKEN`, `CORE_URL`, `BROKER_ADVERTISE_URL`, `BROKER_TYPE`); remove Core `SESSION_BROKER_URL` / `SESSION_BROKER_SECRET`; redeploy both. Mirror the completed 2026-08-21 deploy.
- Admin UI: a "Brokers" console screen (list + issue token) — backend-only in this slice; a plain admin API is sufficient until the frontend plugin host exists.
- Second broker type (e.g. `openai-key`) when a real need arrives.
```
