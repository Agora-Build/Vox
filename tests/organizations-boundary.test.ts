import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Files allowed to read the raw org columns off a row-shaped object:
//
// - organizations-core.ts: the built-in provider — reading the columns is its job.
// - storage.ts: the data-access layer that serves the provider (and the rest of
//   the app) the raw `User` row in the first place.
// - permissions.ts: holds the deliberately-structural predicates (`sameOrg`,
//   `canDispatchToToken`, `isOwnerOperatedAgent`, …) whose params are typed
//   `{ organizationId: number | null }` — org-id carriers, not user rows. The
//   module imports no storage and cannot originate a column read; its callers
//   convert membership before calling in, and those call sites ARE scanned.
//
// Everything else must go through getOrganizations(). Scans source rather than
// re-listing call sites, so it cannot drift out of date — same approach as
// tests/sensitive-paths.test.ts.
const ALLOWED = new Set(["organizations-core.ts", "storage.ts", "permissions.ts"]);

// User-shaped identifiers only. Resource-shaped reads (workflow.organizationId)
// are permanent Core FK columns and must NOT be flagged.
//
// The `(?!\w*[Mm]embership\b)` lookahead excludes any identifier ending in
// Membership/membership (e.g. `user.membership?.organizationId`,
// `memberMembership.organizationId`) — those are seam-derived objects, not raw
// column reads, and a naive pattern self-matches on the very code that fixes
// the problem this test guards against.
//
// `creator` and `owner` were added after a real escape: the scheduler passed a
// raw `User` row named `creator` into a predicate whose param is typed
// `{ organizationId: number | null }`. That is structurally valid TypeScript, so
// neither `tsc` nor this scan saw it — the identifier simply was not listed.
const FORBIDDEN = /\b(?!\w*[Mm]embership\b)(user|currentUser|targetUser|member|actor|apiKeyUser|tokenOwner|creator|owner)\w*\.(organizationId|orgRole)\b/;

// Raw snake_case column SQL. `users.organization_id` is scoped to the users
// table specifically (other tables — web_sessions, org_secrets — legitimately
// own their own `organization_id` column as a resource-ownership FK, exactly
// like `workflow.organizationId`, and must NOT be flagged). `org_role` has no
// analog on any other table, so it is matched bare, unqualified.
const SNAKE_FORBIDDEN = /\busers\.organization_id\b|\borg_role\b/;

// Alias bypass: `SELECT … FROM users u WHERE u.organization_id = $1` is the same
// read as `users.organization_id`, but table-qualified matching never sees it.
// Second pass, deliberately file-scoped: in any file that itself contains raw
// users-table SQL, the BARE column names are forbidden too. Scoping it that way
// is what keeps the OTHER tables' own `organization_id` FK columns
// (web_sessions, org_secrets — resource ownership, exactly like
// workflow.organizationId) unflagged everywhere else. Verified zero false
// positives on the tree as of this commit: no server/plugin .ts file contains
// raw users-table SQL at all, so this pass is a tripwire for the next one that
// does — including a plugin's own provider implementation in Phase 2.
const USERS_TABLE_SQL = /\bfrom\s+users\b|\bjoin\s+users\b/i;
const SNAKE_BARE_FORBIDDEN = /\borganization_id\b|\borg_role\b/;

// A line so tagged is an audited, justified provider-serving org-column site.
//
// Honest scope: the marker is an INVENTORY PIN, not (today) an active
// exemption. All 7 markers in server/storage.ts sit on full-line comments,
// which `scanLines` already skips before SNAKE_FORBIDDEN is tested, and the
// code they annotate uses Drizzle's camelCase builder, which SNAKE_FORBIDDEN
// never matches — so removing them would not change the snake-case result. What
// they buy is the pinned COUNT below: a reviewable list of storage.ts's
// provider-serving surface (every entry slated for deletion or re-pointing in
// Release B) that a future PR cannot change without a conscious update.
// The `markerExempt` mechanism itself is real and generic — the falsifiability
// fixtures exercise it on a marked CODE line — so a genuine future exemption
// can use it; it simply is not carrying any today.
const MARKER = "// org-columns: provider";

/**
 * The scan itself — walk, comment-skip, ALLOWED filter, and offender
 * formatting all live here ONCE. Both the real assertion below and the
 * falsifiability fixture call this same function, so the fixture exercises
 * the shipped code path (including the ALLOWED skip) instead of a hand-copied
 * re-implementation of it that could silently drift from what actually runs.
 *
 * Walk is TOP-LEVEL ONLY (`entry.isFile()`, no recursion into subdirectories)
 * — `server/plugins/**` and `server/data/**` are NOT scanned by this helper.
 * (Recursive plugin-directory coverage is a separate helper below, since only
 * the snake-case check extends there.)
 *
 * `pattern` defaults to FORBIDDEN and `markerExempt` defaults to false, so
 * every existing call site (and existing assertion) is unchanged bit-for-bit.
 */
function scan(dir: string, allowed: Set<string>, pattern: RegExp = FORBIDDEN, markerExempt = false): string[] {
  const offenders: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (allowed.has(entry.name)) continue;
    offenders.push(...scanLines(path.join(dir, entry.name), entry.name, pattern, markerExempt));
  }
  return offenders;
}

/** Per-file line scan shared by `scan()` (top-level dir walk) and the
 * recursive plugin-directory walk below — one comment-skip/marker-skip
 * implementation, reused everywhere. */
function scanLines(filePath: string, label: string, pattern: RegExp, markerExempt: boolean): string[] {
  const offenders: string[] = [];
  readFileSync(filePath, "utf-8")
    .split("\n")
    .forEach((line, i) => {
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
      if (!pattern.test(line)) return;
      if (markerExempt && line.includes(MARKER)) return;
      offenders.push(`${label}:${i + 1}: ${line.trim()}`);
    });
  return offenders;
}

// Recursive .ts file listing, tolerant of a missing directory — both
// server/plugins (today real, non-empty) and plugins-dir-per-plugin server
// dirs (today real) are expected to eventually gain more nesting in Phase 2,
// and this must not throw if a given plugin has no server dir yet.
function walkTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Every location the org-column scans (both patterns, where applicable) must
// cover: server-top-level .ts (handled by scan() directly), plus
// server/plugins top-level .ts, and each plugin's own server dir, recursively
// — no-op today for the camelCase pattern (no org-column reads live there
// yet), load-bearing once org data moves into a plugin in Phase 2.
function pluginTsFiles(): string[] {
  const serverPluginsDir = path.resolve(__dirname, "../server/plugins");
  const pluginsRootDir = path.resolve(__dirname, "../plugins");
  const files: string[] = [];
  if (existsSync(serverPluginsDir)) {
    for (const entry of readdirSync(serverPluginsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path.join(serverPluginsDir, entry.name));
    }
  }
  if (existsSync(pluginsRootDir)) {
    for (const entry of readdirSync(pluginsRootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      files.push(...walkTsFiles(path.join(pluginsRootDir, entry.name, "server")));
    }
  }
  return files;
}

function scanFileList(files: string[], pattern: RegExp, markerExempt: boolean): string[] {
  const offenders: string[] = [];
  for (const f of files) offenders.push(...scanLines(f, f, pattern, markerExempt));
  return offenders;
}

/**
 * The alias-bypass pass: SNAKE_BARE_FORBIDDEN, but only inside files that
 * contain raw users-table SQL (USERS_TABLE_SQL). Same walk, same comment-skip
 * and marker handling as every other pass — it just picks its file set first.
 */
function scanAliasBypass(files: string[]): string[] {
  const offenders: string[] = [];
  for (const f of files) {
    if (!USERS_TABLE_SQL.test(readFileSync(f, "utf-8"))) continue;
    offenders.push(...scanLines(f, f, SNAKE_BARE_FORBIDDEN, true));
  }
  return offenders;
}

/** Counts audited-exemption marker lines in a file (path relative to repo root). */
function countMarkers(relPath: string): number {
  const full = path.resolve(__dirname, "..", relPath);
  return readFileSync(full, "utf-8")
    .split("\n")
    .filter((l) => l.includes(MARKER)).length;
}

// Step 3's enumeration: after Tasks 5-9 removed the business-logic org-column
// SQL from routes, the sites below are what legitimately remains in
// storage.ts — the provider-serving surface `CoreOrganizations` is built on.
// Release B deletes or re-points every one of them.
const EXPECTED_MARKERS = 7;

describe("organizations boundary", () => {
  it("no user-shaped org-column read outside the provider, storage, and the structural predicates", () => {
    const offenders = scan(path.resolve(__dirname, "../server"), ALLOWED);
    expect(offenders, `read membership via getOrganizations() instead:\n${offenders.join("\n")}`).toEqual([]);
  });

  // Falsifiability: prove the scan can actually fail, using a scratch fixture
  // so no tracked production file is touched — and prove the ALLOWED skip
  // itself works, by seeding a violation into a file named like an allowed
  // one (`storage.ts`) alongside a violation in a non-allowed file. Only the
  // latter may appear in the offender list.
  it("flags a violation when present, and skips it when the file is ALLOWED (falsifiability check)", () => {
    const tmp = path.join(tmpdir(), `org-boundary-fixture-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, "fixture.ts"),
      [
        "const u = await storage.getUser(1);",
        "const x = user.organizationId;",
        "const r = member.orgRole;",
        // The two identifiers added after the scheduler escape — asserted here so
        // the widened alternation is proven to fire, not merely present.
        "const c = creator.organizationId;",
        "const o = owner.orgRole;",
        "// user.organizationId in a comment must not count",
      ].join("\n"),
    );
    // Same shape of violation, but in a file named like an ALLOWED entry —
    // proves scan()'s `allowed.has(entry.name)` filter actually suppresses
    // it, rather than merely being asserted true by a comment.
    writeFileSync(path.join(tmp, "storage.ts"), "const x = user.organizationId;\n");

    const offenders = scan(tmp, new Set(["storage.ts"]));

    expect(offenders).toEqual([
      "fixture.ts:2: const x = user.organizationId;",
      "fixture.ts:3: const r = member.orgRole;",
      "fixture.ts:4: const c = creator.organizationId;",
      "fixture.ts:5: const o = owner.orgRole;",
    ]);
  });

  it("does not fire on legitimate seam reads or resource-shaped FK reads", () => {
    const legit = [
      "const x = user.membership?.organizationId;",
      "const y = memberMembership.organizationId;",
      "const z = workflow.organizationId;",
      "orgRole: updated?.orgRole,",
    ];
    for (const line of legit) {
      expect(FORBIDDEN.test(line), line).toBe(false);
    }
  });

  // --- Task 12: snake-case hardening ---------------------------------------

  it("snake-case org-column SQL appears only on provider-marked lines", () => {
    // storage.ts is deliberately NOT in an ALLOWED set here — unlike the
    // camelCase scan above, it gets no file-level exemption from this
    // pattern. Any hit must carry the MARKER on the same line instead.
    const topLevel = scan(path.resolve(__dirname, "../server"), new Set(), SNAKE_FORBIDDEN, true);
    const pluginHits = scanFileList(pluginTsFiles(), SNAKE_FORBIDDEN, true);
    const offenders = [...topLevel, ...pluginHits];
    expect(offenders, `mark with "${MARKER}" + a one-line justification, or fix through the seam:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the marker count is pinned — a new exemption is a conscious act", () => {
    expect(countMarkers("server/storage.ts")).toBe(EXPECTED_MARKERS);
  });

  it("flags an unmarked snake-case violation, and clears it once marked (falsifiability check)", () => {
    const tmp = path.join(tmpdir(), `org-boundary-snake-fixture-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, "fixture.ts"),
      [
        "const q = `SELECT * FROM x WHERE users.organization_id = 1`;",
        "const r = row.org_role;",
        `const marked = row.org_role; ${MARKER} — legit test fixture line`,
        "// a comment mentioning users.organization_id must not count",
      ].join("\n"),
    );

    const offenders = scan(tmp, new Set(), SNAKE_FORBIDDEN, true);

    expect(offenders).toEqual([
      "fixture.ts:1: const q = `SELECT * FROM x WHERE users.organization_id = 1`;",
      "fixture.ts:2: const r = row.org_role;",
    ]);
  });

  it("storage.ts is not blanket-exempt from the snake-case pattern (falsifiability check)", () => {
    const tmp = path.join(tmpdir(), `org-boundary-snake-storage-fixture-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(path.join(tmp, "storage.ts"), "const r = `WHERE users.organization_id = 1`;\n");

    // Note: no ALLOWED set exempting storage.ts by name — that blanket
    // exemption existed only for the camelCase pattern.
    const offenders = scan(tmp, new Set(), SNAKE_FORBIDDEN, true);

    expect(offenders).toEqual(["storage.ts:1: const r = `WHERE users.organization_id = 1`;"]);
  });

  it("raw users-table SQL cannot smuggle the columns in through an alias", () => {
    const offenders = scanAliasBypass(scannedServerFiles());
    expect(
      offenders,
      `this file contains raw users-table SQL, so bare organization_id/org_role reads it through an alias — go through the seam:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("flags an aliased column read, and only inside files with users-table SQL (falsifiability check)", () => {
    const tmp = path.join(tmpdir(), `org-boundary-alias-fixture-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    // Alias form: invisible to SNAKE_FORBIDDEN, caught by this pass.
    writeFileSync(
      path.join(tmp, "alias.ts"),
      [
        "const q = sql`SELECT u.id FROM users u WHERE u.organization_id = ${orgId}`;",
        "const r = sql`SELECT c.org_role FROM x JOIN users c ON c.id = x.created_by`;",
        `const marked = sql\`SELECT u.org_role FROM users u\`; ${MARKER} — audited`,
        "// a comment with u.organization_id and FROM users must not count",
      ].join("\n"),
    );
    // Same bare column, but the file has no users-table SQL: another table's own
    // ownership FK (web_sessions.organization_id) — must stay unflagged.
    writeFileSync(
      path.join(tmp, "other-table.ts"),
      "const q = sql`SELECT id FROM web_sessions WHERE organization_id = ${orgId}`;\n",
    );
    expect(SNAKE_FORBIDDEN.test("WHERE u.organization_id = 1")).toBe(false); // the bypass is real

    const offenders = scanAliasBypass([path.join(tmp, "alias.ts"), path.join(tmp, "other-table.ts")]);

    expect(offenders).toHaveLength(2);
    expect(offenders[0]).toMatch(/alias\.ts:1: /);
    expect(offenders[1]).toMatch(/alias\.ts:2: /);
  });

  // --- Ruling H: the decrypt tail is pinned to its single fenced call site --
  //
  // storage.getDecryptedOrgRuntimeSecrets is a decrypt tail with NO internal
  // fence — its safety depends entirely on orgRuntimeSecretsForJob
  // (server/routes.ts) being its ONLY caller. This proves that invariant by
  // scanning source rather than trusting a comment, the same way the rest of
  // this file works.

  /** Non-comment occurrences of a whole-word identifier across a file list. */
  function identifierOccurrences(files: string[], identifier: string, excludeNames: Set<string>): string[] {
    const idPattern = new RegExp(`\\b${identifier}\\b`);
    const hits: string[] = [];
    for (const f of files) {
      if (excludeNames.has(path.basename(f))) continue;
      readFileSync(f, "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
          if (idPattern.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    return hits;
  }

  function scannedServerFiles(): string[] {
    const serverDir = path.resolve(__dirname, "../server");
    const topLevel = readdirSync(serverDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => path.join(serverDir, e.name));
    return [...topLevel, ...pluginTsFiles()];
  }

  it("getDecryptedOrgRuntimeSecrets is called from exactly one site outside storage.ts, and it is server/routes.ts", () => {
    const hits = identifierOccurrences(scannedServerFiles(), "getDecryptedOrgRuntimeSecrets", new Set(["storage.ts"]));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/[\\/]routes\.ts:/);
  });

  it("flags a second call site to the decrypt tail (falsifiability check)", () => {
    const tmp = path.join(tmpdir(), `org-boundary-decrypt-tail-fixture-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(path.join(tmp, "storage.ts"), "async getDecryptedOrgRuntimeSecrets() {}\n");
    writeFileSync(path.join(tmp, "routes.ts"), "return storage.getDecryptedOrgRuntimeSecrets(scope.workflowOrgId);\n");
    // A second, rogue call site — the thing that must never happen for real.
    writeFileSync(path.join(tmp, "rogue-plugin.ts"), "return storage.getDecryptedOrgRuntimeSecrets(otherOrgId);\n");

    const hits = identifierOccurrences(
      [path.join(tmp, "storage.ts"), path.join(tmp, "routes.ts"), path.join(tmp, "rogue-plugin.ts")],
      "getDecryptedOrgRuntimeSecrets",
      new Set(["storage.ts"]),
    );

    expect(hits).toHaveLength(2);
  });
});
