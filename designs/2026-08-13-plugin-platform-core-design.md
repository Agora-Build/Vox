# Plugin Platform Core (Backend) — Design Spec

**Status:** Approved for implementation
**Date:** 2026-08-13
**Parent:** [`designs/2026-08-12-vox-plugin-architecture-plan.md`](./2026-08-12-vox-plugin-architecture-plan.md) (Phase 2, backend portion)
**Sub-project:** 1 of the "platform first → shared-agents" decomposition

---

## 1. Context and goal

The parent architecture plan proposes turning Vox into a trusted modular monolith with
restart-loaded plugins. `shared-agents` — the eventual target — is Phase 8–10 and sits atop
a plugin platform (Phase 2), Credits (Phase 6), and a Core job-transaction cleanup (Phase 1),
**none of which exist in the repository today** (verified: no `plugins/`, no `@vox/plugin-sdk`,
no service registry, no `CreditService`; Organizations tables do exist).

This spec covers **sub-project 1: the minimal plugin platform core, backend only** — the
machinery that discovers a plugin, validates it, runs its migrations, wires its routes and
workers, reports its health, and shuts it down cleanly, plus a throwaway **sample plugin** that
exercises all of it (the Phase 2 exit-gate proof).

`shared-agents` itself is roughly six sub-projects downstream. Sub-project 1 is the required
first step regardless of whether the platform is later proven on Clash (the parent doc's
recommendation) or driven straight toward shared-agents; that ordering fork does not need to
be decided now.

### 1.1 Goals

- A plugin can add a route, a migration, a worker, a health check, and a provided service, and
  can shut down cleanly, **without Core importing the plugin**.
- The Core/plugin boundary is real: plugins own their own Postgres schema and may import only
  `@vox/plugin-sdk`; violations fail CI.
- Strict, fail-loud startup: a misconfigured plugin stops the server rather than silently
  degrading it.
- The existing Core migration mechanism (`server/migrate.ts`) is untouched.

### 1.2 Non-goals (deferred to later sub-projects)

| Deferred capability | First real consumer | Sub-project |
|---|---|---|
| WebSocket host | Clash | 5 (Clash extraction) |
| Raw-body webhook host | Stripe payments | (Phase 7) |
| Frontend / `@vox/web-plugin-sdk` / plugin UI loading | any plugin page | 2 (frontend host) |
| Full `PluginTransaction` (cross-plugin enlistment, `afterCommit`, settlement) | Credits / shared-agents | 3 (job-tx cleanup) |
| `vox plugin drain <id>` CLI | first stateful plugin | 4 (Credits) |
| npm workspaces / separately-built plugin artifacts | plugin in another repo | future |

### 1.3 Packaging decision

**Path-alias, in-tree plugins** (chosen over true npm workspaces). `@vox/plugin-sdk` lives at
`packages/plugin-sdk/` and is resolved by a `tsconfig`/esbuild path alias — no workspaces, no
separately-built artifacts. Plugins under `plugins/<id>/` are part of the existing single
esbuild bundle (and loaded via `tsx` in dev). The Core/plugin boundary is enforced logically by
an ESLint import rule rather than physically by package walls. This keeps every architectural
boundary the parent doc cares about while leaving the single-bundle build untouched; flipping on
workspaces later is a mechanical follow-up because the code boundaries are already correct.

The one capability this does **not** prove — "load a plugin built as a standalone artifact" —
is explicitly out of scope until a plugin needs to ship from another repo.

---

## 2. Directory layout

New directories in **bold**.

```
packages/
  plugin-sdk/              ← @vox/plugin-sdk (path-aliased, pre-1.0)
    index.ts              ← the ONLY module plugins may import
    types.ts              ← VoxPlugin, VoxPluginContext, reports
    services.ts          ← ServiceAccess types
    hosts.ts             ← RouteRegistrar, WorkerSpec types
server/
  plugins/                ← Core-side platform (NOT itself a plugin)
    loader.ts            ← discover → validate → resolve order → activate → mount
    registry.ts          ← service registry (provide / require / optional, semver)
    manifest.ts          ← vox.plugin.json Zod schema + strict validator
    migrate.ts           ← plugin migration runner + _plugin_schema_versions
    context.ts           ← builds the VoxPluginContext handed to each plugin
    db.ts                ← schema-scoped PluginDb over the existing pg pool
    hosts/
      http.ts            ← mounts /api/plugins/<id>/* routers, conflict detection
      worker.ts          ← interval workers with advisory-lock singleton leasing
      health.ts          ← GET /api/plugins, GET /api/plugins/:id/health
plugins/
  sample/                 ← exit-gate proof + template
    vox.plugin.json
    SPEC.md
    server/index.ts
    migrations/0001_init.sql
    tests/
scripts/
  plugins-validate.ts    ← npm run plugins:validate (manifest ↔ SPEC.md drift)
```

---

## 3. SDK surface (`@vox/plugin-sdk`)

This is the entire contract a plugin author sees; everything in `server/plugins/` is
Core-private. Keeping this surface small is the stability commitment.

```ts
export interface VoxPlugin {
  activate(ctx: VoxPluginContext): Promise<void>;
  deactivate?(): Promise<void>;          // graceful shutdown, not hot-unload
}

export interface VoxPluginContext {
  readonly pluginId: string;
  readonly logger: Logger;                       // namespaced [plugin:<id>]
  readonly config: ConfigReader;                 // reads only this plugin's declared ENV
  readonly services: ServiceAccess;
  readonly db: PluginDb;                          // scoped to this plugin's schema
  http(register: (r: RouteRegistrar) => void): void;   // /api/plugins/<id>/*
  worker(spec: WorkerSpec): void;
  health(check: () => Promise<HealthReport>): void;
  drain?(check: () => Promise<DrainReport>): void;
  provideService<T>(name: string, version: string, impl: T): void;
}

export interface ServiceAccess {
  require<T>(name: string, range: string): T;    // unmet → throws → fails startup
  optional<T>(name: string, range: string): T | null;
}

export interface PluginDb {
  readonly schema: string;                        // e.g. "plugin_sample"
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  withTransaction<T>(fn: (tx: PluginDb) => Promise<T>): Promise<T>;
}

export interface WorkerSpec {
  id: string;
  intervalMs: number;
  singleton?: boolean;          // advisory-lock so only one instance runs the tick
  run(): Promise<void>;
  onShutdown?(): Promise<void>;
}

export interface RouteRegistrar {          // thin; Core owns auth/CSRF/errors
  get(path: string, ...h: Handler[]): void;
  post(path: string, ...h: Handler[]): void;
  patch(path: string, ...h: Handler[]): void;
  delete(path: string, ...h: Handler[]): void;
  requireAuth: Handler;         // Core-provided middleware, re-exported
  requireAdmin: Handler;
}

export interface HealthReport { status: "ok" | "degraded" | "down"; detail?: string; }
export interface DrainReport  { ready: boolean; blockers: string[]; }
```

Key design points:

1. **`ctx.db` is schema-scoped.** It is a query handle over the app's existing `pg.Pool`, bound
   to the plugin's own Postgres schema (`plugin_sample`). It physically cannot name another
   plugin's or Core's tables. This is the handle-level backing of "a plugin must not read/write
   another plugin's tables" (parent §11.1). For Core data a plugin must go through a service.
2. **`provideService` / `services.require`** are the only cross-plugin channel — never imports.
3. **`http()` yields a thin registrar, not raw Express.** Core wraps every plugin handler with
   the existing auth/CSRF/request-id/error middleware and re-exports `requireAuth`/`requireAdmin`
   so plugins reuse Core's authorization.

---

## 4. Loader lifecycle and startup semantics

Triggered by `VOX_PLUGINS` (comma-separated plugin ids; empty = Core-only). Runs once during
startup in `server/index.ts`, **before `httpServer.listen()`**.

```
1. DISCOVER   read plugins/<id>/vox.plugin.json for each id in VOX_PLUGINS
2. VALIDATE   strict Zod parse: known fields only, valid semver, voxPluginApi range
              satisfies the SDK version, no duplicate ids
3. RESOLVE    build dependency graph from requires/providesServices; topological
              sort → activation order; detect cycles, missing required services,
              duplicate singleton providers
4. MIGRATE    acquire the plugin-migration advisory lock; run each enabled plugin's
              migrations in dependency order (see §5)
5. ACTIVATE   for each plugin in order: build VoxPluginContext, call activate(ctx);
              it registers routes/workers/health/services
6. MOUNT      attach all /api/plugins/<id> routers, start workers, expose health
7. listen()
```

**Service registry** (`registry.ts`) is the matchmaker in steps 3 and 5.
`provideService(name, version, impl)` registers a versioned entry; `require(name, range)`
resolves by semver. Because activation follows the topological order, a provider is always
active before its consumer.

**Strict fail-fast (fail-before-`listen`).** Any of the following aborts boot with a clear
message — the server does not come up, and there is no "start with that plugin skipped" mode
(confirmed decision; safest for a money-adjacent system):

- unknown plugin id in `VOX_PLUGINS`
- manifest invalid / incompatible `voxPluginApi`
- required service missing or version-incompatible
- duplicate singleton provider, or a route-path conflict between two plugins
- a declared-required ENV secret is unset
- migration failure or checksum mismatch

The **only** permitted degradation: an *optional* service being absent leaves the plugin in its
documented reduced-feature mode. Dev (`NODE_ENV !== production`) throws on the same conditions
but with fix-oriented messages.

**Shutdown ordering:** on `SIGTERM`/`SIGINT`, Core calls each plugin's `deactivate()` in reverse
activation order (consumers before providers), stops workers, then closes HTTP — a plugin never
receives a request or tick after it is told to stop.

---

## 5. Plugin migration runner

**Core migrations are untouched.** `server/migrate.ts` (the `_schema_version` single-row runner
run as `dist/migrate.cjs` before app boot) stays as-is. Plugins get a **parallel in-process
runner** (`server/plugins/migrate.ts`) invoked at loader step 4, so plugin schemas migrate
automatically on startup in both dev (`tsx`) and prod — no `db:push` needed for plugin tables.

**Registry table** (Core-owned, created if missing — parent §11.2), multi-row keyed by plugin:

```sql
CREATE TABLE IF NOT EXISTS _plugin_schema_versions (
  plugin_id  text    NOT NULL,
  version    integer NOT NULL,
  checksum   text    NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, version)
);
```

**Per-plugin flow**, in dependency order, all under a **single advisory lock** whose ID is
distinct from Core's `987654321` (so two app instances cannot double-run):

```
for each enabled plugin, in activation order:
  1. CREATE SCHEMA IF NOT EXISTS plugin_<id>
  2. list plugins/<id>/migrations/*.sql, sorted by numeric prefix (0001, 0002, …)
  3. for each file NOT recorded in _plugin_schema_versions:
       - run its statements in ONE transaction (split on "--> statement-breakpoint",
         same convention as Core), with search_path pinned to plugin_<id>
       - record (plugin_id, version, checksum = sha256(fileContents)) in the SAME tx
  4. for each file ALREADY recorded:
       - recompute checksum; if it differs from the stored value → FAIL STARTUP
         ("plugin <id> migration 000N changed after release")
```

Properties, from the parent doc:

1. **Forward-only immutability, checked.** A released migration file's checksum is frozen;
   editing it after release refuses to boot. (Core enforces this by append-only convention; for
   plugins it is a checked invariant, since plugin authors are less disciplined than Core.)
2. **Schema isolation created here.** `CREATE SCHEMA plugin_<id>` precedes the plugin's first
   migration and `search_path` is pinned during the run, so `CREATE TABLE agent_profiles` lands
   in `plugin_<id>.agent_profiles`, never `public`. This physically backs the `ctx.db` fence.

**Authoring difference from Core:** plugin migrations are plain hand-written `.sql` files
numbered `0001_*.sql`, discovered by directory listing — **not** drizzle-kit generated and
**not** registered in any TypeScript array.

---

## 6. Hosts

### 6.1 HTTP host (`hosts/http.ts`)

- One Express `Router` per plugin, mounted at `/api/plugins/<id>`.
- Every handler wrapped with Core's existing middleware chain (session, request-id,
  `requireAuth`/`requireAdmin`, error conversion), re-exported through the registrar so plugins
  reuse Core authz.
- **Route-conflict detection at mount time:** two plugins claiming the same method+path fails
  startup. A plugin cannot register outside its own prefix and cannot shadow a Core route.

### 6.2 Worker host (`hosts/worker.ts`)

- Runs `run()` on `intervalMs` using the same `setInterval` model as the existing Core
  background worker in `server/index.ts`.
- For `singleton: true`, each tick is guarded by a Postgres advisory lock
  (`pg_try_advisory_lock` keyed by a hash of `plugin_id:worker_id`); if the lock is not acquired
  the tick is skipped (not queued), so across multiple instances only one runs the work.
- Calls `onShutdown()` on `SIGTERM`/`SIGINT`.

### 6.3 Health & drain host (`hosts/health.ts`)

- `GET /api/plugins` → `[{ id, version, status, servicesProvided, servicesRequired }]`.
- `GET /api/plugins/:id/health` → invokes the plugin's registered `health()` →
  `{ status, detail }`.
- `drain()` is **declarable and surfaced in health**, but its trigger (`vox plugin drain <id>`
  CLI) is deferred to the first stateful plugin. No half-built CLI in this slice.

---

## 7. Sample plugin (exit-gate proof)

`plugins/sample/` is the proof that the platform works and the copy-paste template for real
plugins. Trivial in domain (a "notes" toy), complete in mechanics.

```
plugins/sample/
  vox.plugin.json      provides vox.sample@1, requires nothing
  SPEC.md              required doc (identity, routes, env, data ownership, drain, …)
  server/index.ts      export default class implements VoxPlugin
  migrations/0001_init.sql    CREATE TABLE notes (id, body, created_at)
  tests/sample.test.ts
```

`activate()` exercises all five capabilities:

- **route:** `GET`/`POST /api/plugins/sample/notes` (behind `requireAuth`), reading/writing
  `plugin_sample.notes` via `ctx.db`;
- **migration:** the `notes` table, created in `plugin_sample` by the runner;
- **worker:** a `singleton` tick pruning notes older than N (proves interval + advisory lease);
- **health:** `ok` if `ctx.db` responds;
- **service:** `provideService("vox.sample", "1.0.0", { count() })`, with tests that (a) a second
  consumer resolves it and (b) a *missing required service* fails startup — the negative test is
  what actually proves the registry.

### 7.1 Manifest example (`vox.plugin.json`)

```json
{
  "id": "sample",
  "version": "1.0.0",
  "voxPluginApi": "^1.0.0",
  "providesServices": { "vox.sample": "1.0.0" },
  "requiresServices": {},
  "optionalServices": {},
  "migrations": "migrations",
  "routes": [
    "GET /api/plugins/sample/notes",
    "POST /api/plugins/sample/notes"
  ]
}
```

The loader rejects unknown fields, invalid versions, incompatible API ranges, duplicate ids,
duplicate singleton providers, route conflicts, and migration checksum changes.

---

## 8. Tooling and CI boundary

### 8.1 `npm run plugins:validate` (`scripts/plugins-validate.ts`)

A contract lint, run in CI. For each plugin, the manifest's declared `routes`,
`providesServices`, `requiresServices`, and env vars must each appear in `SPEC.md`, and
vice-versa; drift → non-zero exit; missing `SPEC.md` → fail. This is the parent doc's
"documentation cannot silently drift" guarantee (§8.1).

### 8.2 ESLint import boundary

The teeth behind "plugins import only the SDK" (parent §5.2), under path-alias packaging where
there is no package wall. A `no-restricted-imports` / `import/no-restricted-paths` rule scoped to
`plugins/**`:

- **allowed:** `@vox/plugin-sdk`, normal npm deps, relative imports within the same plugin;
- **forbidden:** `server/**`, `shared/**`, `client/**`, `@/*`, `@shared/*` — any reach into Core
  internals fails lint.

This rule is load-bearing, not optional.

### 8.3 Build/config wiring

- `tsconfig.json` `paths`: add `"@vox/plugin-sdk": ["./packages/plugin-sdk/index.ts"]`;
  add `packages/**/*` and `plugins/**/*` to `include`.
- `scripts/build.ts`: the esbuild bundle already resolves `tsconfig` paths; confirm the alias
  resolves in the CJS build (add an esbuild alias if needed).
- `package.json`: add `"plugins:validate": "tsx scripts/plugins-validate.ts"`.

---

## 9. Testing

Vitest, following existing conventions (`tests/*.test.ts`, real imports).

- **`tests/plugin-loader.test.ts`** — manifest validation (rejects unknown fields, bad semver,
  incompatible `voxPluginApi`); dependency resolution (topological order, cycle detection,
  missing-required-service throws, duplicate singleton provider throws, route conflict throws).
- **`tests/plugin-migrate.test.ts`** — applies `0001` then `0002` in order; skips
  already-applied; checksum-mismatch-on-applied throws; schema created + `search_path` isolation
  (a plugin `CREATE TABLE` lands in `plugin_<id>`, not `public`).
- **`tests/plugin-sample.test.ts`** (integration, local dev DB) — POST then GET a note
  round-trips through `ctx.db`; worker tick prunes; `/api/plugins` and
  `/api/plugins/sample/health` report correctly; service `count()` resolves.
- **CI wiring:** `plugins:validate` and the ESLint boundary run in the same lane as
  `npm run check` + `npm test`.

Baseline discipline: `npm run check` clean and the full suite green (existing ~9 known-baseline
failures unchanged) before any push.

---

## 10. Exit gate

Sub-project 1 is done when: **the sample plugin adds a route, a migration, a worker, a health
check, and a provided service, and shuts down cleanly — with Core never importing it, the
import-boundary lint green, and `VOX_PLUGINS=` (no plugins) leaving all existing Vox behavior and
tests unchanged.**

This maps to the parent doc's Phase 2 exit gate (backend portion; page + navigation contribution
belong to the deferred frontend host in sub-project 2).
