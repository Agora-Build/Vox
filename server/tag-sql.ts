/**
 * Network tags in SQL — the effective-value rule of `effectiveTags`
 * (shared/tags.ts; designs/2026-10-22-network-tags-design.md "Which value a
 * board uses") as a jsonb expression over `eval_jobs.tags`, so metrics can
 * filter BEFORE their row limit and bucketed views can group by a tag.
 *
 * This is the second implementation of one rule. tests/network-tags-sql.test.ts
 * runs every fixture through both and fails on any disagreement — change the
 * two together.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { KNOWN_TAG_KEYS, type Tag, type TagBoard, type TagSource } from "@shared/tags";

/** The tag key syntax (shared/tags.ts KEY_PATTERN). Keys are inlined, so this check is a guard, not a nicety. */
const KEY_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * The value of the FIRST element of `tags` with this key and source, or NULL
 * — `list.find(t => t.source === source)` in effectiveTags (ordinality keeps
 * the array order). A NULL or non-array `tags` (jobs from before the release)
 * has no elements, so every value is NULL and no filter matches.
 *
 * Key and source are inlined as literals rather than bound: a bucketed view
 * groups by this expression, and Postgres only accepts a select-list
 * expression as grouped when it is identical to the GROUP BY one — two binds
 * of the same value are different parameters ($1 vs $5).
 */
function firstValue(tags: SQLWrapper, key: string, source: TagSource): SQL {
  return sql`(SELECT e->>'value' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${tags}) = 'array' THEN ${tags} ELSE '[]'::jsonb END) WITH ORDINALITY AS jt(e, i) WHERE e->>'key' = ${sql.raw(`'${key}'`)} AND e->>'source' = ${sql.raw(`'${source}'`)} ORDER BY i LIMIT 1)`;
}

/**
 * The effective value (text, or NULL = untagged) of `key` on `board`. Each
 * branch names the effectiveTags rule it mirrors.
 */
export function effectiveTagValueSql(tags: SQLWrapper, board: TagBoard, key: string): SQL {
  if (!KEY_PATTERN.test(key)) throw new Error(`effectiveTagValueSql: invalid tag key ${JSON.stringify(key)}`);
  const detected = firstValue(tags, key, "detected");
  const agent = firstValue(tags, key, "agent");
  const flow = firstValue(tags, key, "flow");

  if (board === "mainline") {
    if (key === "line") {
      // `if (detected) detected` → else `key === "line" && !hasDetectedLine && flow`.
      // For key "line", "a detected line exists" is exactly "detected is not
      // NULL", so the fallback is COALESCE. An agent-set line never counts here.
      return sql`COALESCE(${detected}, ${flow})`;
    }
    if ((KNOWN_TAG_KEYS as readonly string[]).includes(key)) {
      // isp / link / sim: detected only — a hand-set-only value stays untagged.
      return sql`${detected}`;
    }
    // Custom key: `if (detected) detected` → else `agent ?? flow`.
    return sql`COALESCE(${detected}, ${agent}, ${flow})`;
  }
  // community / myEvals: `agent ?? flow ?? detected` — hand-set beats detected.
  return sql`COALESCE(${agent}, ${flow}, ${detected})`;
}

/** One `tag=key:value` filter: the job's effective value of `key` on `board` is `value` (NULL never matches). */
export function tagFilterCondition(tags: SQLWrapper, board: TagBoard, filter: Tag): SQL {
  return sql`(${effectiveTagValueSql(tags, board, filter.key)}) = ${filter.value}`;
}
