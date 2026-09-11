import { describe, it, expect } from "vitest";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
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

/**
 * The scan itself — walk, comment-skip, ALLOWED filter, and offender
 * formatting all live here ONCE. Both the real assertion below and the
 * falsifiability fixture call this same function, so the fixture exercises
 * the shipped code path (including the ALLOWED skip) instead of a hand-copied
 * re-implementation of it that could silently drift from what actually runs.
 *
 * Walk is TOP-LEVEL ONLY (`entry.isFile()`, no recursion into subdirectories)
 * — `server/plugins/**` and `server/data/**` are NOT scanned.
 */
function scan(dir: string, allowed: Set<string>): string[] {
  const offenders: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (allowed.has(entry.name)) continue;
    readFileSync(path.join(dir, entry.name), "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
        if (FORBIDDEN.test(line)) offenders.push(`${entry.name}:${i + 1}: ${line.trim()}`);
      });
  }
  return offenders;
}

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
});
