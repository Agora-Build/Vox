import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
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
const FORBIDDEN = /\b(?!\w*[Mm]embership\b)(user|currentUser|targetUser|member|actor|apiKeyUser|tokenOwner)\w*\.(organizationId|orgRole)\b/;

describe("organizations boundary", () => {
  it("no user-shaped org-column read outside the provider, storage, and the structural predicates", () => {
    const dir = path.resolve(__dirname, "../server");
    const offenders: string[] = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (ALLOWED.has(entry.name)) continue;
      readFileSync(path.join(dir, entry.name), "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
          if (FORBIDDEN.test(line)) offenders.push(`${entry.name}:${i + 1}: ${line.trim()}`);
        });
    }

    expect(offenders, `read membership via getOrganizations() instead:\n${offenders.join("\n")}`).toEqual([]);
  });

  // Falsifiability: prove the scan logic actually flags a violation, using a
  // scratch fixture so no tracked production file is touched. Mirrors the real
  // scan (same regex, same comment-skip, same file-iteration shape) against a
  // temp directory instead of server/.
  it("flags a violation when one is present (falsifiability check)", () => {
    const os = require("fs");
    const tmp = require("path").join(require("os").tmpdir(), "org-boundary-fixture");
    os.mkdirSync(tmp, { recursive: true });
    os.writeFileSync(
      path.join(tmp, "fixture.ts"),
      [
        "const u = await storage.getUser(1);",
        "const x = user.organizationId;",
        "const r = member.orgRole;",
        "// user.organizationId in a comment must not count",
      ].join("\n"),
    );

    const offenders: string[] = [];
    for (const entry of os.readdirSync(tmp, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      os.readFileSync(path.join(tmp, entry.name), "utf-8")
        .split("\n")
        .forEach((line: string, i: number) => {
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
          if (FORBIDDEN.test(line)) offenders.push(`${entry.name}:${i + 1}: ${line.trim()}`);
        });
    }

    expect(offenders).toEqual([
      "fixture.ts:2: const x = user.organizationId;",
      "fixture.ts:3: const r = member.orgRole;",
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
