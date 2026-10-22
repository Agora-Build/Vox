import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { effectiveTags, type JobTag, type TagBoard } from "../shared/tags";
import { db } from "../server/storage";
import { effectiveTagValueSql, tagFilterCondition, groupValueSql } from "../server/tag-sql";
import { groupValue } from "../server/metrics-params";

// The metrics filter runs in SQL (realtime has a LIMIT — filtering after it
// would be wrong) while grouping runs in JS through `effectiveTags`. Two
// implementations of one rule (designs/2026-10-22-network-tags-design.md
// "Which value a board uses"): this suite feeds the same fixtures to both and
// fails on any disagreement, so they can't drift.

const d = process.env.DATABASE_URL ? describe : describe.skip;

const t = (key: string, value: string, source: JobTag["source"]): JobTag => ({ key, value, source });

const FIXTURES: Array<{ name: string; tags: JobTag[] | null }> = [
  { name: "null (pre-release job)", tags: null },
  { name: "empty", tags: [] },
  { name: "flow line only (no lookup)", tags: [t("line", "twilio", "flow")] },
  { name: "flow line + detected line", tags: [t("line", "twilio", "flow"), t("line", "bandwidth", "detected")] },
  { name: "agent line only", tags: [t("line", "telnyx", "agent")] },
  { name: "agent + flow line", tags: [t("line", "telnyx", "agent"), t("line", "twilio", "flow")] },
  { name: "agent + flow + detected line", tags: [t("line", "twilio", "flow"), t("line", "bandwidth", "detected"), t("line", "telnyx", "agent")] },
  { name: "hand-set isp only", tags: [t("isp", "att", "agent")] },
  { name: "hand-set + detected isp", tags: [t("isp", "att", "agent"), t("isp", "starlink", "detected")] },
  { name: "detected isp only", tags: [t("isp", "starlink", "detected")] },
  { name: "flow sim only", tags: [t("sim", "att", "flow")] },
  // System keys (access, sim): detected only on EVERY board — a hand-set
  // value (which no route can store) is ignored even where hand-set wins.
  { name: "agent sim + detected sim", tags: [t("sim", "att", "agent"), t("sim", "t-mobile", "detected")] },
  { name: "detected sim only (with reason)", tags: [{ ...t("sim", "t-mobile", "detected"), reason: "v1: sim-match 310-260" }] },
  { name: "flow + agent access, no detected", tags: [t("access", "lastmile", "flow"), t("access", "datacenter", "agent")] },
  { name: "agent access + detected access", tags: [t("access", "lastmile", "agent"), { ...t("access", "datacenter", "detected"), reason: "v1: dc-range" }] },
  { name: "link from all three", tags: [t("link", "wifi", "flow"), t("link", "cellular", "detected"), t("link", "ethernet", "agent")] },
  { name: "custom: flow + agent", tags: [t("codec", "opus", "flow"), t("codec", "g711", "agent")] },
  { name: "custom: flow only", tags: [t("codec", "opus", "flow")] },
  { name: "custom: flow + detected", tags: [t("codec", "opus", "flow"), t("codec", "pcm", "detected")] },
  { name: "duplicate detected: first wins", tags: [t("isp", "first", "detected"), t("isp", "second", "detected")] },
  { name: "duplicate agent: first wins", tags: [t("isp", "first", "agent"), t("isp", "second", "agent")] },
  { name: "detected line + flow isp (lookup ≠ isp)", tags: [t("line", "bandwidth", "detected"), t("isp", "att", "flow")] },
  {
    name: "everything",
    tags: [
      t("line", "twilio", "flow"), t("codec", "opus", "flow"), t("line", "bandwidth", "detected"),
      t("isp", "comcast", "agent"), t("isp", "att", "detected"), t("link", "wifi", "detected"),
    ],
  },
];

const BOARDS: TagBoard[] = ["mainline", "community", "myEvals"];
const KEYS = ["line", "isp", "link", "access", "sim", "codec", "absent"];

d("tag SQL agrees with effectiveTags", () => {
  const jsonbOf = (tags: JobTag[] | null) => (tags === null ? sql`NULL::jsonb` : sql`${JSON.stringify(tags)}::jsonb`);

  for (const f of FIXTURES) {
    for (const board of BOARDS) {
      it(`${f.name} · ${board}`, async () => {
        const expected = effectiveTags(f.tags, board);
        for (const key of KEYS) {
          const col = jsonbOf(f.tags);
          // The effective value expression (used by bucketed groupBy).
          const want = expected.find((e) => e.key === key)?.value ?? null;
          const got = (await db.execute(sql`SELECT ${effectiveTagValueSql(col, board, key)} AS v`)).rows[0].v;
          expect(got, `value of ${key}`).toBe(want);

          // The filter predicate, for every value this fixture holds under the
          // key (whatever its source) plus one it doesn't.
          const values = new Set([...(f.tags ?? []).filter((x) => x.key === key).map((x) => x.value), "nomatch"]);
          for (const value of Array.from(values)) {
            const matches = expected.some((e) => e.key === key && e.value === value);
            const row = (await db.execute(sql`SELECT (${tagFilterCondition(col, board, { key, value })}) IS TRUE AS m`)).rows[0];
            expect(row.m, `filter ${key}:${value}`).toBe(matches);
          }
        }
      });
    }
  }

  it("refuses a key that isn't tag syntax (it is inlined into the SQL)", () => {
    expect(() => effectiveTagValueSql(sql`NULL::jsonb`, "mainline", "x'; DROP TABLE users; --")).toThrow();
  });
});

// groupBy=region (design "Group by region"): bucketed views group in SQL
// (`groupValueSql`), raw rows and leaderboards in JS (`groupValue`). Same
// rule twice — the recording region of an analysis, else the site's
// location base, else "unattributed" — so the same fixtures go through both.
d("groupBy SQL agrees with groupValue", () => {
  const text = (v: string | null) => (v === null ? sql`NULL::text` : sql`${v}::text`);
  const REGION_FIXTURES: Array<{ name: string; siteId: string | null; recordingRegion: string | null; want: string }> = [
    { name: "site", siteId: "apac-in-mumbai-01", recordingRegion: null, want: "apac-in-mumbai" },
    { name: "site, two-digit+ sequence", siteId: "na-us-seattle-112", recordingRegion: null, want: "na-us-seattle" },
    { name: "site base containing digits", siteId: "eu-de-frankfurt2-03", recordingRegion: null, want: "eu-de-frankfurt2" },
    { name: "analysis: recording region, no site", siteId: null, recordingRegion: "eu-de-frankfurt", want: "eu-de-frankfurt" },
    { name: "recording region wins over a site", siteId: "na-us-seattle-01", recordingRegion: "sa-br-saopaulo", want: "sa-br-saopaulo" },
    { name: "neither", siteId: null, recordingRegion: null, want: "unattributed" },
  ];
  for (const f of REGION_FIXTURES) {
    it(`region · ${f.name}`, async () => {
      const js = groupValue({ jobTags: null, siteId: f.siteId, recordingRegion: f.recordingRegion }, "mainline", "region");
      const got = (await db.execute(sql`SELECT ${groupValueSql({ tags: sql`NULL::jsonb`, siteId: text(f.siteId), recordingRegion: text(f.recordingRegion) }, "mainline", "region")} AS v`)).rows[0].v;
      expect(js).toBe(f.want);
      expect(got).toBe(f.want);
    });
  }

  it("a tag groupBy falls back to untagged in both", async () => {
    for (const f of FIXTURES) {
      for (const board of BOARDS) {
        for (const key of KEYS) {
          const js = groupValue({ jobTags: f.tags, siteId: "na-us-seattle-01", recordingRegion: null }, board, key);
          const tags = f.tags === null ? sql`NULL::jsonb` : sql`${JSON.stringify(f.tags)}::jsonb`;
          const got = (await db.execute(sql`SELECT ${groupValueSql({ tags, siteId: sql`'na-us-seattle-01'::text`, recordingRegion: sql`NULL::text` }, board, key)} AS v`)).rows[0].v;
          expect(got, `${f.name} · ${board} · ${key}`).toBe(js);
        }
      }
    }
  });
});
