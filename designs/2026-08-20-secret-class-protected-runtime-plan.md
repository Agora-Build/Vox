# Secret Class "Protected / Runtime" + Shared-Agent Exposure Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the secret class `login` → `protected` end-to-end (DB enum + server + client), default the secret picker to Protected, add a run-flow agent picker, and gate runtime-secret exposure to shared agents behind an explicit acknowledgement.

**Architecture:** A security-atomic enum rename lands first (schema + hand-authored migration + every server comparison in one task, so a renamed DB value is never read by code still comparing to `"login"` — that would leak protected secrets). Then two pure helpers (`collectSecretRefs`, `findProtectedMisuse`) plus a thin DB join (`classifyReferencedSecrets`) feed two new run-route gates: a Protected-outside-login misuse rejection and a Runtime-on-shared consent gate. A new `run-targets` endpoint surfaces targetable agents + referenced-secret classes so the client can offer an agent picker and warn before a shared run.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres enum), Express, React 19 + TanStack Query + shadcn/ui, Vitest (unit + live-HTTP integration), Playwright (E2E).

**Spec:** `designs/2026-08-20-secret-class-protected-runtime-design.md`

## Global Constraints

- **Deep rename** `login` → `protected`: DB enum value, server code, client code — not just labels. Verbatim class token is `"protected"`.
- **Naming exception:** identifiers named after the login *mechanism* (`emailSecret`, `passwordSecret`, `sessionInjection`, `areLoginSecretsAttested`) are **not** renamed. Only the class token and helpers named after the *class* are: `getLoginSecretNames` → `getProtectedSecretNames`.
- **Protected withholding is a security invariant:** a `protected`-class secret is never in an eval agent's payload, at any dispatch tier. The rename must not alter this filter's semantics.
- **Downgrade guard preserved:** a `protected` secret cannot be reclassified to `runtime` via upsert (400).
- **UI default is Protected** (`protected`), tagged **(Recommended)**. DB column default stays `runtime` (API callers omitting `class` are unaffected).
- **Exact microcopy:** Protected help = "Processed securely by Core. The raw secret is never exposed to agents." Runtime help = "Sent directly to the agent at runtime. Only use with agents you trust." Banner title = "This workflow uses runtime secrets"; banner body = "The selected shared agent will receive the raw values of these secrets." Acknowledgement label = "I understand".
- **Server gates are authoritative.** Every UI gate has a matching server 400 so a direct API caller can't bypass it.
- **Migration rules:** hand-authored SQL (no `drizzle-kit generate`), plain SQL (no `IF EXISTS`/`DO` tricks), registered in the `MIGRATIONS` array in `server/migrate.ts`, next version `30`, file `migrations/0029_secret_class_protected.sql`.
- **Every commit** ends with `🤖 Built with SMT <smt@agora.build>`.
- **Before pushing:** `npm run check` + `npm test` must pass. (Not part of per-task cycles, but the branch gate.)
- **Integration tests run against a live server.** After server code + migration changes, apply the migration and restart the dev server before running `tests/*.test.ts` that use `authFetch`/`fetch` against `localhost:5000`:
  ```bash
  DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:migrate
  ./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
  ```

---

### Task 1: Rename secret class `login` → `protected` (DB enum + migration + server + tests)

Security-atomic. The Postgres enum value, every server comparison, the class-named helper, and affected tests move together so no intermediate state reads a renamed value with stale code. Ends green on `npm run check` + affected unit/integration tests.

**Files:**
- Modify: `shared/schema.ts:19` (enum)
- Create: `migrations/0029_secret_class_protected.sql`
- Modify: `server/migrate.ts:24-54` (register version 30)
- Modify: `server/storage.ts:2014`, `:2482`, `:2522`, and the two opts-type unions at `:1968` and `:2422` (per the summary's line map — confirm by search)
- Modify: `server/routes.ts:2473-2474`, `:2486-2487`, `:2567-2568`, `:2573-2574`, `:2492`, `:2579`, `:6039-6056`
- Modify: `server/session-broker.ts:104-111` (rename `getLoginSecretNames` → `getProtectedSecretNames`, update reads), `server/routes.ts:3717` (caller)
- Modify: any `tests/*.ts` referencing the `"login"` class (search)

**Interfaces:**
- Produces: `secretClassEnum` values `["runtime", "protected"]`; `Secret.class` / `OrgSecret.class` inferred type `"runtime" | "protected"`; `getProtectedSecretNames(scope: SessionScope): Promise<Set<string>>` (replaces `getLoginSecretNames`, same behavior).

- [ ] **Step 1: Write the failing test** — update the existing secret-class integration test to the new value. Search first: `grep -rn '"login"' tests/`. In `tests/secrets-class-api.test.ts` (and any other hit), replace `secretClass: "login"` with `secretClass: "protected"`, expected `class: "login"` assertions with `"protected"`, and the reclass-guard expectation to reject `protected`→`runtime`. Add a withhold assertion if not already present:

```ts
// A protected secret is never delivered to an agent's job payload (any tier).
it("withholds protected-class secrets from job secrets", async () => {
  // (reuse the file's existing helpers to create a protected secret on the
  //  workflow owner, create a job, then fetch job secrets as the agent)
  const names = jobSecrets.map((s: any) => s.name);
  expect(names).not.toContain("PROTECTED_LOGIN_EMAIL");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/secrets-class-api.test.ts`
Expected: FAIL — server still validates/returns `"login"`; `secretClass: "protected"` is rejected with 400 "secretClass must be 'runtime' or 'login'".

- [ ] **Step 3: Rename the enum + write the migration**

`shared/schema.ts:19`:
```ts
export const secretClassEnum = pgEnum("secret_class", ["runtime", "protected"]);
```

Create `migrations/0029_secret_class_protected.sql`:
```sql
-- Rename the secret_class enum value 'login' → 'protected'.
-- Postgres renames the value in place; existing rows keep their identity, and
-- the type name (secret_class) and column name (class) are unchanged.
ALTER TYPE secret_class RENAME VALUE 'login' TO 'protected';
```

Register in `server/migrate.ts` — append after the `version: 29` entry (line 53):
```ts
  { version: 30, description: "rename secret_class value login → protected", file: "0029_secret_class_protected.sql" },
```

- [ ] **Step 4: Rename every server comparison + the class-named helper**

`server/storage.ts:2014`:
```ts
    return all.filter((s) => s.class !== "protected");
```
`server/storage.ts:2482`:
```ts
      if (s.class === "protected") continue; // Core-only (Phase C) — never sent to agents
```
`server/storage.ts:2522` (inside `areLoginSecretsAttested` — keep the function name):
```ts
    return names.every(n => rows.some(r => r.name === n && r.class === "protected" && r.isTestAccount));
```
Opts-type unions — `server/storage.ts` `createOrUpdateSecret` (~:1968) and `upsertOrgSecret` (~:2422): change `class?: "runtime" | "login"` → `class?: "runtime" | "protected"`.

`server/routes.ts:2473-2474`:
```ts
      if (secretClass !== undefined && secretClass !== "runtime" && secretClass !== "protected") {
        return res.status(400).json({ error: "secretClass must be 'runtime' or 'protected'" });
```
`server/routes.ts:2486-2487`:
```ts
      if (existingRow && existingRow.class === "protected" && secretClass === "runtime") {
        return res.status(400).json({ error: "A protected secret cannot be reclassified to runtime — delete and recreate it instead" });
```
`server/routes.ts:2567-2568` and `:2573-2574` — apply the identical two edits to the org-secrets handler.

`server/routes.ts:6039-6056` (clash-runner secrets withhold) — update the comparison and wording:
```ts
      // Fetch and decrypt event owner's secrets. PROTECTED-class secrets are
      // structurally withheld: Core-only credentials used to mint web sessions,
      // never handed to a runner (MEDIUM-2). Only runtime-class secrets are
      // decrypted for direct injection.
      const userSecrets = await storage.getSecretsByUserId(event.createdBy);
      const decrypted: Record<string, string> = {};
      let decryptErrors = 0;
      let protectedWithheld = 0;
      for (const s of userSecrets) {
        if (s.class === "protected") { protectedWithheld++; continue; }
```
…and the log line: `${protectedWithheld} protected-class withheld`.

`server/session-broker.ts:104-111` — rename and update reads:
```ts
export async function getProtectedSecretNames(scope: SessionScope): Promise<Set<string>> {
  if ("userId" in scope) {
    const rows = await storage.getSecretsByUserId(scope.userId);
    return new Set(rows.filter(s => s.class === "protected").map(s => s.name));
  }
  const rows = await storage.getOrgSecrets(scope.organizationId);
  return new Set(rows.filter(s => s.class === "protected").map(s => s.name));
}
```
`server/routes.ts:3717` — update the caller:
```ts
      const sessionReq = evaluateSessionRequirement(setupInfo, await getProtectedSecretNames(scope));
```
Also update the routes.ts import of `getLoginSecretNames` from `./session-broker` to `getProtectedSecretNames`. Then `grep -rn 'getLoginSecretNames\|=== "login"\|!== "login"\|: "login"' server/ shared/` and fix any remaining hit.

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: PASS (no `"login"` comparisons remain; the enum type is now `"runtime" | "protected"`).

- [ ] **Step 6: Apply migration + restart dev server, then run the integration test**

```bash
DATABASE_URL="postgresql://vox:vox123@localhost:5432/vox" npm run db:migrate
./scripts/dev-local-run.sh stop && ./scripts/dev-local-run.sh start
npx vitest run tests/secrets-class-api.test.ts
```
Expected: PASS. Also run the daemon unit suite to catch any withhold expectation: `npx vitest run tests/eval-agent-daemon.test.ts` (update any `"login"` fixture to `"protected"` if it fails).

- [ ] **Step 7: Commit**

```bash
git add shared/schema.ts migrations/0029_secret_class_protected.sql server/migrate.ts server/storage.ts server/routes.ts server/session-broker.ts tests/
git commit -m "$(cat <<'EOF'
refactor(secrets): rename secret class login → protected (enum + migration + server)

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

### Task 2: Client rename + default Protected + labels

Update the secrets page to the new class value, default the picker to Protected, and apply the mental-model copy. Server-independent for `npm run check`; sequenced after Task 1 so the API accepts `protected`.

**Files:**
- Modify: `client/src/pages/console-secrets.tsx` (types `:24`, `:37`; state defaults `:67`, `:119`; mutation bodies `:83`, `:133`; reset `:90`, `:139`; Select options ~`:244-258`, ~`:388-402`; badges ~`:307-312`, ~`:452-457`)

**Interfaces:**
- Consumes: server accepts/returns class `"protected"` (Task 1).

- [ ] **Step 1: Rename the union types + default state to Protected**

`console-secrets.tsx:24` and `:37`: `class: "runtime" | "protected";`
`:67`: `const [secretClass, setSecretClass] = useState<"runtime" | "protected">("protected");`
`:119`: `const [orgSecretClass, setOrgSecretClass] = useState<"runtime" | "protected">("protected");`
Mutation bodies `:83` and `:133`: `isTestAccount: secretClass === "protected" ? isTestAccount : undefined,` (and `orgSecretClass === "protected"` for org).
Reset-on-success `:90` and `:139`: reset to the new default — `setSecretClass("protected");` / `setOrgSecretClass("protected");`.

- [ ] **Step 2: Relabel the Select options + help text + badges**

In each `<Select>` (personal ~244-258, org ~388-402), the two `<SelectItem>`s become:
```tsx
<SelectItem value="protected">Protected (Recommended)</SelectItem>
<SelectItem value="runtime">Runtime</SelectItem>
```
Add help text under each select (use the existing description/`<p className="text-xs text-muted-foreground">` pattern in the file), switching on the selected class:
- Protected: `Processed securely by Core. The raw secret is never exposed to agents.`
- Runtime: `Sent directly to the agent at runtime. Only use with agents you trust.`

Badges (~307-312, ~452-457): render `class` verbatim, so a `protected` secret now shows `<Badge variant="outline">protected</Badge>` automatically — confirm no hard-coded `login` string remains (`grep -n login client/src/pages/console-secrets.tsx`).

- [ ] **Step 3: Type-check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Manual verification**

With the dev server running, open `/console/secrets`, click **Add secret**. Confirm: the class select shows **Protected (Recommended)** selected by default, the help text reads "Processed securely by Core…", and switching to **Runtime** reveals "Sent directly to the agent…". Create one Protected and one Runtime secret; confirm the table badges read `protected` / `runtime`.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/console-secrets.tsx
git commit -m "$(cat <<'EOF'
feat(secrets-ui): default Protected, relabel class picker (Protected/Runtime)

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

### Task 3: `collectSecretRefs` helper (shared/secrets.ts)

Enumerate every `${secrets.NAME}` a config references, regardless of nesting, by stringifying and scanning.

**Files:**
- Modify: `shared/secrets.ts` (append `collectSecretRefs`)
- Create: `tests/secrets-refs.test.ts`

**Interfaces:**
- Produces: `collectSecretRefs(configs: unknown[]): Set<string>` — accepts strings or objects (jsonb configs); returns the set of referenced names.

- [ ] **Step 1: Write the failing test**

`tests/secrets-refs.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { collectSecretRefs } from "../shared/secrets";

describe("collectSecretRefs", () => {
  it("collects names from a string config", () => {
    expect(collectSecretRefs(["email: ${secrets.MY_EMAIL}\npw: ${secrets.MY_PW}"]))
      .toEqual(new Set(["MY_EMAIL", "MY_PW"]));
  });
  it("collects names from a nested object config", () => {
    const cfg = { stepsPrefix: "x: ${secrets.A}", scenario: { params: { key: "${secrets.B}" } } };
    expect(collectSecretRefs([cfg])).toEqual(new Set(["A", "B"]));
  });
  it("dedupes across multiple configs and ignores null", () => {
    expect(collectSecretRefs([null, "${secrets.A}", { v: "${secrets.A}" }]))
      .toEqual(new Set(["A"]));
  });
  it("returns empty for configs with no refs", () => {
    expect(collectSecretRefs([{ a: 1 }, "plain"])).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/secrets-refs.test.ts`
Expected: FAIL with "collectSecretRefs is not a function".

- [ ] **Step 3: Implement `collectSecretRefs`** — append to `shared/secrets.ts`:
```ts
/**
 * Enumerate every ${secrets.NAME} referenced across one or more configs.
 * Objects (jsonb workflow/eval-set configs) are JSON-stringified before
 * scanning — $ { } . are all JSON-safe inside a string, so the placeholder
 * regex still matches. A fresh RegExp per config avoids shared-lastIndex bugs
 * with the module-level global regex.
 */
export function collectSecretRefs(configs: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const cfg of configs) {
    if (cfg == null) continue;
    const text = typeof cfg === "string" ? cfg : JSON.stringify(cfg);
    const re = new RegExp(SECRET_PLACEHOLDER_REGEX.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) names.add(m[1]);
  }
  return names;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/secrets-refs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/secrets.ts tests/secrets-refs.test.ts
git commit -m "$(cat <<'EOF'
feat(secrets): add collectSecretRefs config reference enumerator

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

### Task 4: `classifyReferencedSecrets` + `findProtectedMisuse` (session-broker.ts)

The DB join that attaches class + presence to referenced names, and the pure misuse predicate (a Protected secret referenced anywhere but the login pair).

**Files:**
- Modify: `server/session-broker.ts` (append both functions)
- Create: `tests/protected-misuse.test.ts` (unit-tests the pure `findProtectedMisuse`)

**Interfaces:**
- Consumes: `SessionScope` (already imported in session-broker.ts), `storage.getSecretsByUserId` / `storage.getOrgSecrets`.
- Produces:
  - `classifyReferencedSecrets(scope: SessionScope, names: Set<string>): Promise<Array<{ name: string; class: "runtime" | "protected"; present: boolean }>>`
  - `findProtectedMisuse(classified: Array<{ name: string; class: string }>, loginPair: { emailSecret: string; passwordSecret: string } | null): string[]`

- [ ] **Step 1: Write the failing test**

`tests/protected-misuse.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { findProtectedMisuse } from "../server/session-broker";

describe("findProtectedMisuse", () => {
  const pair = { emailSecret: "LOGIN_EMAIL", passwordSecret: "LOGIN_PW" };
  it("allows protected secrets that are exactly the login pair", () => {
    const classified = [
      { name: "LOGIN_EMAIL", class: "protected" },
      { name: "LOGIN_PW", class: "protected" },
    ];
    expect(findProtectedMisuse(classified, pair)).toEqual([]);
  });
  it("flags a protected secret referenced outside the login pair", () => {
    const classified = [
      { name: "LOGIN_EMAIL", class: "protected" },
      { name: "LOGIN_PW", class: "protected" },
      { name: "API_TOKEN", class: "protected" },
    ];
    expect(findProtectedMisuse(classified, pair)).toEqual(["API_TOKEN"]);
  });
  it("flags any protected ref when there is no login pair", () => {
    expect(findProtectedMisuse([{ name: "X", class: "protected" }], null)).toEqual(["X"]);
  });
  it("ignores runtime secrets", () => {
    expect(findProtectedMisuse([{ name: "X", class: "runtime" }], null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/protected-misuse.test.ts`
Expected: FAIL with "findProtectedMisuse is not a function".

- [ ] **Step 3: Implement both functions** — append to `server/session-broker.ts`:
```ts
/**
 * Join referenced secret NAMES against the scope's secret rows, attaching each
 * name's class and whether it exists. Names with no matching row default to
 * class "runtime" / present:false (a dangling ref delivers nothing).
 */
export async function classifyReferencedSecrets(
  scope: SessionScope,
  names: Set<string>,
): Promise<Array<{ name: string; class: "runtime" | "protected"; present: boolean }>> {
  const rows = "userId" in scope
    ? await storage.getSecretsByUserId(scope.userId)
    : await storage.getOrgSecrets(scope.organizationId);
  return [...names].map((name) => {
    const row = rows.find((r) => r.name === name);
    return { name, class: (row?.class ?? "runtime") as "runtime" | "protected", present: !!row };
  });
}

/**
 * A Protected secret is only meaningful as a platform.setup login credential.
 * Returns the names of Protected secrets referenced anywhere OTHER than the
 * given login pair — i.e. misconfigurations the run route must reject.
 */
export function findProtectedMisuse(
  classified: Array<{ name: string; class: string }>,
  loginPair: { emailSecret: string; passwordSecret: string } | null,
): string[] {
  const allowed = new Set(loginPair ? [loginPair.emailSecret, loginPair.passwordSecret] : []);
  return classified.filter((c) => c.class === "protected" && !allowed.has(c.name)).map((c) => c.name);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/protected-misuse.test.ts && npm run check`
Expected: PASS (4 tests) + clean type-check.

- [ ] **Step 5: Commit**

```bash
git add server/session-broker.ts tests/protected-misuse.test.ts
git commit -m "$(cat <<'EOF'
feat(secrets): classifyReferencedSecrets + findProtectedMisuse helpers

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

### Task 5: Protected-misuse pre-run validation (run route)

Reject a run when a Protected secret is referenced as anything but the workflow's `platform.setup` login pair. Introduces the shared `referenced`/`classified` computation reused by Task 6.

**Files:**
- Modify: `server/routes.ts` — imports; insert after `:3721`
- Modify: `tests/session-dispatch.test.ts` (or the file that already sets up secret-bearing workflows) — add a misuse integration case

**Interfaces:**
- Consumes: `collectSecretRefs` (Task 3), `classifyReferencedSecrets` + `findProtectedMisuse` (Task 4), existing `scope`, `sessionNeed`, `workflow`, `evalSet` in the run handler.
- Produces: in-scope `const classified` (array of `{ name, class, present }`) available to the rest of the run handler (Task 6 reuses it).

- [ ] **Step 1: Write the failing test** — add to the run-route integration suite (model setup on the file's existing helpers that create a workflow + owner secret + run it):
```ts
it("rejects a run when a Protected secret is used outside platform.setup login", async () => {
  // owner has a PROTECTED secret API_TOKEN; workflow.config references
  // ${secrets.API_TOKEN} in stepsPrefix (NOT as a platform.setup email/password).
  const res = await authFetch(ownerCookie, `/api/workflows/${workflowId}/run`, {
    method: "POST",
    body: JSON.stringify({ region, evalSetId }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/Protected secret/i);
  expect(body.error).toContain("API_TOKEN");
});
```

- [ ] **Step 2: Run it to verify it fails**

Apply migration + restart dev server (see Global Constraints), then:
Run: `npx vitest run tests/session-dispatch.test.ts -t "outside platform.setup login"`
Expected: FAIL — the run currently succeeds (200) because no misuse gate exists.

- [ ] **Step 3: Add the imports + validation**

In `server/routes.ts`, extend the `@shared/secrets` import to include `collectSecretRefs`, and the `./session-broker` import to include `classifyReferencedSecrets, findProtectedMisuse`.

Insert immediately after `const sessionNeed: SessionNeed | null = ...` (line 3721), before `let jobRegion: string;`:
```ts
      // Enumerate every ${secrets.NAME} the workflow + eval set reference, with
      // class + presence. Drives the Protected-misuse gate here and the
      // Runtime-on-shared consent gate in the targeted branch below.
      const classified = await classifyReferencedSecrets(
        scope,
        collectSecretRefs([workflow.config, evalSet.config]),
      );
      // A Protected secret is only meaningful as a platform.setup login credential.
      // Any other reference is a misconfiguration — reject with a clear message
      // instead of a silently broken run.
      const misused = findProtectedMisuse(
        classified,
        sessionNeed ? { emailSecret: sessionNeed.emailSecret, passwordSecret: sessionNeed.passwordSecret } : null,
      );
      if (misused.length > 0) {
        return res.status(400).json({
          error: `Protected secret(s) ${misused.join(", ")} are referenced as runtime values — Protected secrets can only be login credentials in platform.setup. Mark them Runtime or remove the reference.`,
        });
      }
```

- [ ] **Step 4: Run it to verify it passes**

Restart the dev server (code changed), then:
Run: `npx vitest run tests/session-dispatch.test.ts`
Expected: PASS (new case + no regression). Also `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts tests/session-dispatch.test.ts
git commit -m "$(cat <<'EOF'
feat(run): reject Protected secrets referenced outside platform.setup login

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

### Task 6: Runtime-on-shared consent gate + snapshot field

When a run targets a shared token and exposes present Runtime secrets, require `runtimeSecretConsent === true` and record it on the immutable snapshot.

**Files:**
- Modify: `shared/schema.ts` — add `runtimeSecretConsent?: boolean` to `JobSnapshot` (after `:329`)
- Modify: `server/routes.ts` — declare flag near `:3726`; gate inside the shared branch after `:3744`; snapshot spread near `:3805`
- Modify: `tests/session-dispatch.test.ts` — shared-dispatch consent cases

**Interfaces:**
- Consumes: `classified` (Task 5), existing shared branch (`token.dispatchTier === "shared"`), `req.body.runtimeSecretConsent`.
- Produces: `snapshot.runtimeSecretConsent === true` on a consented shared run that exposes runtime secrets.

- [ ] **Step 1: Write the failing tests** — add to the shared-dispatch integration suite (reuse its existing shared-token + marketplace setup):
```ts
it("blocks a shared run exposing runtime secrets without consent", async () => {
  const res = await authFetch(renterCookie, `/api/workflows/${wfWithRuntimeSecret}/run`, {
    method: "POST",
    body: JSON.stringify({ evalSetId, targetTokenId: sharedTokenId }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/runtime secret/i);
});

it("allows it with runtimeSecretConsent and records it on the snapshot", async () => {
  const res = await authFetch(renterCookie, `/api/workflows/${wfWithRuntimeSecret}/run`, {
    method: "POST",
    body: JSON.stringify({ evalSetId, targetTokenId: sharedTokenId, runtimeSecretConsent: true }),
  });
  expect(res.status).toBe(200);
  const { job } = await res.json();
  expect(job.snapshot.runtimeSecretConsent).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/session-dispatch.test.ts -t "runtime secrets"`
Expected: FAIL — the run currently returns 200 with no consent, and the snapshot has no `runtimeSecretConsent`.

- [ ] **Step 3: Add the snapshot field**

`shared/schema.ts`, inside the `JobSnapshot` type after the `credentialConsent?: boolean;` line (`:329`):
```ts
  // True iff the dispatcher acknowledged that this run exposes runtime-class
  // secrets to a shared (stranger's) agent. Recorded for audit alongside
  // credentialConsent; the run route's shared branch requires it before an
  // escrow hold is placed.
  runtimeSecretConsent?: boolean;
```

- [ ] **Step 4: Add the flag, the gate, and the snapshot spread** in `server/routes.ts`

Near `let consentRecorded = false;` (`:3726`) add:
```ts
      let runtimeConsentRecorded = false;
```
Inside the shared branch, immediately after the `if (sessionNeed) { … }` block closes (`:3744`) and before `const authz = await marketplace.authorizeDispatch(`:
```ts
          // Runtime secrets reach a shared (stranger's) agent raw. Require the
          // dispatcher to acknowledge that exposure BEFORE any escrow hold is
          // placed. Server-authoritative so a direct API caller can't skip the
          // UI checkbox. Only present runtime secrets actually get delivered.
          const runtimeExposed = classified.filter((c) => c.class === "runtime" && c.present).map((c) => c.name);
          if (runtimeExposed.length > 0) {
            if (req.body.runtimeSecretConsent !== true) {
              return res.status(400).json({
                error: `This run exposes runtime secret(s) ${runtimeExposed.join(", ")} to a shared agent. Set runtimeSecretConsent=true to acknowledge.`,
              });
            }
            runtimeConsentRecorded = true;
          }
```
In the snapshot assembly (`:3802-3813`), add one spread line alongside `credentialConsent`:
```ts
        ...(runtimeConsentRecorded ? { runtimeSecretConsent: true } : {}),
```

- [ ] **Step 5: Run to verify they pass**

Restart the dev server, then:
Run: `npx vitest run tests/session-dispatch.test.ts && npm run check`
Expected: PASS (both new cases + no regression).

- [ ] **Step 6: Commit**

```bash
git add shared/schema.ts server/routes.ts tests/session-dispatch.test.ts
git commit -m "$(cat <<'EOF'
feat(run): gate runtime-secret exposure to shared agents behind consent

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

### Task 7: `run-targets` endpoint (agents + referenced secrets)

Surface the tokens a user may target and the workflow's referenced-secret classes in one call, so the client can offer an agent picker and drive the runtime-exposure banner.

**Files:**
- Modify: `server/routes.ts` — new `GET /api/workflows/:id/run-targets`
- Modify: `tests/session-dispatch.test.ts` (or `tests/api.test.ts`) — endpoint integration test

**Interfaces:**
- Consumes: `storage.getEvalAgentTokensByUser`, `storage.getEvalAgentToken`, `getMarketplace().listDispatchable` (`AgentSummary { tokenId, region, pricePerUnit, ownerId }`), `storage.getEvalSet`, `canRunWorkflow`, `canAccessResource`, `sessionScopeForWorkflow`, `collectSecretRefs`, `classifyReferencedSecrets`.
- Produces: `{ agents: { mine: Agent[]; shared: Agent[] }, referencedSecrets: Array<{ name, class, present }> }` where `Agent = { tokenId: number; name: string; region: string; dispatchTier: string; price: number | null }`.

- [ ] **Step 1: Write the failing test**
```ts
it("run-targets lists own tokens and referenced-secret classes", async () => {
  // ownerCookie owns tokenId in `region`; workflow references a RUNTIME secret RT_KEY.
  const res = await authFetch(ownerCookie, `/api/workflows/${workflowId}/run-targets?region=${region}&evalSetId=${evalSetId}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.agents.mine.map((a: any) => a.tokenId)).toContain(tokenId);
  expect(body.referencedSecrets).toEqual(
    expect.arrayContaining([{ name: "RT_KEY", class: "runtime", present: true }]),
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/session-dispatch.test.ts -t "run-targets"`
Expected: FAIL — 404 (route does not exist).

- [ ] **Step 3: Implement the endpoint** — add near the run route in `server/routes.ts` (after the `/run` handler, before `// ==================== EVAL JOB MANAGEMENT ROUTES ====================` at `:3868`):
```ts
  // Targetable agents + the workflow's referenced-secret classes, for the run
  // dialog's agent picker and the runtime-exposure banner (one round-trip).
  app.get("/api/workflows/:id/run-targets", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const workflow = await storage.getWorkflow(parseInt(req.params.id, 10));
      if (!workflow) return res.status(404).json({ error: "Workflow not found" });
      if (!canRunWorkflow(user, workflow)) {
        return res.status(403).json({ error: "Not authorized to run this workflow" });
      }

      const region = req.query.region ? String(req.query.region) : null;
      const evalSetIdRaw = req.query.evalSetId ? Number(req.query.evalSetId) : null;

      type Agent = { tokenId: number; name: string; region: string; dispatchTier: string; price: number | null };

      // My agents: own tokens, any tier, not revoked, region-filtered when given.
      const ownTokens = await storage.getEvalAgentTokensByUser(user.id);
      const mine: Agent[] = ownTokens
        .filter((t) => !t.isRevoked && (!region || t.region === region))
        .map((t) => ({ tokenId: t.id, name: t.name, region: t.region, dispatchTier: t.dispatchTier, price: null }));

      // Shared marketplace: dispatchable listings from the plugin, if present.
      // AgentSummary has no name, so join the token row for a display name.
      const marketplace = getMarketplace();
      const shared: Agent[] = [];
      if (marketplace) {
        const listings = await marketplace.listDispatchable(user.id);
        for (const l of listings) {
          if (region && l.region !== region) continue;
          const tok = await storage.getEvalAgentToken(l.tokenId);
          if (!tok || tok.isRevoked) continue;
          shared.push({ tokenId: l.tokenId, name: tok.name, region: l.region, dispatchTier: "shared", price: l.pricePerUnit });
        }
      }

      // Referenced secrets + class (workflow config + the chosen eval set, when
      // supplied and visible to the caller).
      const configs: unknown[] = [workflow.config];
      if (evalSetIdRaw != null && Number.isFinite(evalSetIdRaw)) {
        const es = await storage.getEvalSet(evalSetIdRaw);
        if (es && canAccessResource(user, es)) configs.push(es.config);
      }
      const scope = sessionScopeForWorkflow(workflow);
      const referencedSecrets = await classifyReferencedSecrets(scope, collectSecretRefs(configs));

      res.json({ agents: { mine, shared }, referencedSecrets });
    } catch (error) {
      console.error("Error listing run targets:", error);
      res.status(500).json({ error: "Failed to list run targets" });
    }
  });
```
(`sessionScopeForWorkflow` is already imported from `./session-broker`; `canAccessResource`/`canRunWorkflow` are already imported.)

- [ ] **Step 4: Run to verify it passes**

Restart the dev server, then:
Run: `npx vitest run tests/session-dispatch.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts tests/session-dispatch.test.ts
git commit -m "$(cat <<'EOF'
feat(run): add GET /api/workflows/:id/run-targets (agents + referenced secrets)

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

### Task 8: Run-dialog agent picker + runtime-exposure banner + ack checkbox

Wire the endpoint into both run entry points: an Agent selector that sets `targetTokenId`, and, when a shared agent is chosen and the run exposes runtime secrets, a ⚠️ banner + "I understand" checkbox that gates Run and sends `runtimeSecretConsent`.

**Files:**
- Modify: `client/src/pages/console-workflow-detail.tsx` (run mutation `:67-85`, Run dialog `:129-184`)
- Modify: `client/src/pages/run-your-own.tsx` (run mutation `:161-176`, run section `:459-479`)

**Interfaces:**
- Consumes: `GET /api/workflows/:id/run-targets` (Task 7) → `{ agents: { mine, shared }, referencedSecrets }`; run route accepts `targetTokenId` + `runtimeSecretConsent` (Tasks 6).

- [ ] **Step 1: Fetch run-targets + add the Agent selector (console-workflow-detail.tsx)**

Add state: `const [targetTokenId, setTargetTokenId] = useState<string>("any");` and `const [ackRuntime, setAckRuntime] = useState(false);`.
Query the endpoint when the dialog's region/evalSet are chosen:
```tsx
const { data: runTargets } = useQuery<{
  agents: { mine: any[]; shared: any[] };
  referencedSecrets: { name: string; class: string; present: boolean }[];
}>({
  queryKey: [`/api/workflows/${workflowId}/run-targets`, region, evalSetId],
  queryFn: async () => (await apiRequest("GET",
    `/api/workflows/${workflowId}/run-targets?region=${encodeURIComponent(region)}&evalSetId=${evalSetId}`)).json(),
  enabled: !!region && !!evalSetId,
});
```
Add an **Agent** `<Select>` below the eval-set select, defaulting to `any` ("Any available in region"), listing `runTargets.agents.mine` (label group "My agents") and `runTargets.agents.shared` (label group "Shared marketplace", show `price` when non-null). Selecting sets `targetTokenId`.

- [ ] **Step 2: Compute exposure + render the banner + gate the button**
```tsx
const selectedAgent = targetTokenId === "any" ? null :
  [...(runTargets?.agents.mine ?? []), ...(runTargets?.agents.shared ?? [])]
    .find(a => String(a.tokenId) === targetTokenId);
const runtimeExposed = (runTargets?.referencedSecrets ?? [])
  .filter(s => s.class === "runtime" && s.present).map(s => s.name);
const showRuntimeWarning = selectedAgent?.dispatchTier === "shared" && runtimeExposed.length > 0;
```
When `showRuntimeWarning`, render an `<Alert variant="destructive">` (the file already imports `Alert`/`AlertTitle`/`AlertDescription` in the secrets page pattern — import them here too):
```tsx
<Alert variant="destructive">
  <AlertTitle>⚠️ This workflow uses runtime secrets</AlertTitle>
  <AlertDescription>
    The selected shared agent will receive the raw values of these secrets: {runtimeExposed.join(", ")}.
    <label className="mt-2 flex items-center gap-2">
      <Checkbox checked={ackRuntime} onCheckedChange={(v) => setAckRuntime(v === true)} />
      I understand
    </label>
  </AlertDescription>
</Alert>
```
Disable the Run button while `showRuntimeWarning && !ackRuntime`.

- [ ] **Step 3: Send `targetTokenId` + `runtimeSecretConsent`** in the run mutation body:
```tsx
body: JSON.stringify({
  region,
  evalSetId,
  ...(targetTokenId !== "any" ? { targetTokenId: Number(targetTokenId) } : {}),
  ...(showRuntimeWarning ? { runtimeSecretConsent: ackRuntime } : {}),
}),
```
Reset `targetTokenId`/`ackRuntime` on dialog close/success.

- [ ] **Step 4: Repeat the picker + banner + body wiring in `run-your-own.tsx`** (same shape, adapted to that page's run mutation `:161-176` and run section `:459-479`).

- [ ] **Step 5: Type-check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Manual verification**

With the dev server running and a shared agent listed (marketplace plugin active): open a workflow that references a Runtime secret, open **Run**, pick region + eval set, select the shared agent. Confirm the ⚠️ banner lists the runtime secret, the **Run** button is disabled until **I understand** is ticked, and the run succeeds after ticking. Select "Any available in region" or an own agent → no banner, Run enabled. Confirm a shared run without ticking is impossible from the UI (and, via curl without `runtimeSecretConsent`, 400s — already covered by Task 6).

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/console-workflow-detail.tsx client/src/pages/run-your-own.tsx
git commit -m "$(cat <<'EOF'
feat(run-ui): agent picker + runtime-exposure warning with I-understand gate

🤖 Built with SMT <smt@agora.build>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Part 1 (rename DB + code) → Task 1 (server) + Task 2 (client). ✅
- Part 2 (default Protected UI) → Task 2; (Protected-scope validation) → Task 5. ✅
- Part 3 (`collectSecretRefs` + server join) → Task 3 (`collectSecretRefs`) + Task 4 (`classifyReferencedSecrets`). ✅
- Part 4 (run-flow agent picker + `run-targets`) → Task 7 (endpoint) + Task 8 (client). ✅
- Part 5 (runtime→shared warning + required ack + server gate + snapshot provenance) → Task 6 (server gate + snapshot) + Task 8 (banner + checkbox). ✅
- Data model: enum rename → Task 1; `snapshot.runtimeSecretConsent` → Task 6. ✅
- API changes: secret class value/downgrade guard → Task 1; `run-targets` → Task 7; run-route validation + gate → Tasks 5–6. ✅
- Testing strategy: unit (`collectSecretRefs` T3, misuse predicate T4), migration (T1 Step 6), integration (misuse T5, runtime-on-shared T6, run-targets T7), agent-payload withhold (T1 Step 6). ✅
- Non-goals (no untargeted shared routing, no generic secret proxy, no escrow-mechanics change beyond recording consent): respected — Task 6 only reads consent + records it; no new dispatch path. ✅

**2. Placeholder scan:** Every code step carries an exact snippet or exact edit target. Client tasks (2, 8) gate on `npm run check` + concrete manual steps (idiomatic — pages have no unit harness), not a vague "test the UI". Test-file line references (`tests/session-dispatch.test.ts`, `tests/secrets-class-api.test.ts`) name the suite to model setup on; the executor must confirm the exact fixture-helper names by reading the file first (noted in-task). No "TBD"/"handle edge cases"/"similar to Task N".

**3. Type consistency:**
- `classifyReferencedSecrets` returns `{ name; class: "runtime" | "protected"; present }[]` — consumed identically in Tasks 5 (`findProtectedMisuse` takes the looser `{ name; class: string }[]`, compatible), 6 (`c.class === "runtime" && c.present`), and 7 (returned as `referencedSecrets`). ✅
- `collectSecretRefs(configs: unknown[]): Set<string>` — called with `[workflow.config, evalSet.config]` (T5) and a `configs` array (T7); accepts objects/strings/null. ✅
- `getProtectedSecretNames` replaces `getLoginSecretNames` everywhere (T1 renames the definition + the `:3717` caller + import). ✅
- Snapshot field `runtimeSecretConsent?: boolean` (T6 schema) matches the snapshot spread key and the test assertion `job.snapshot.runtimeSecretConsent === true`. ✅
- `Agent` shape in Task 7 (`{ tokenId, name, region, dispatchTier, price }`) matches the Task 8 client consumption (`a.tokenId`, `a.dispatchTier`, `a.price`). ✅

No gaps found.
