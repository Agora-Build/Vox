/**
 * The tags frozen onto `eval_jobs.tags` at claim
 * (designs/2026-10-22-network-tags-design.md "Detection", "Freezing at claim").
 *
 * Sources, in this order:
 *   1. the flow's hand-set tags — from the JOB's frozen snapshot, never the
 *      live flow (source "flow");
 *   2. `line` from the snapshot's number lookup (source "detected") — phone
 *      jobs only (the job's stamped `eval_jobs.transport`): a web job never
 *      dials a number, so a leftover lookup on its snapshot (a flow moved off
 *      phone keeps its `line_lookup`) says nothing about its path;
 *   3. the claiming agent's hand-set tags (source "agent");
 *   4. `isp` from the agent's observed IP via the ASN database (detected);
 *   5. `link` from the agent's reported link type (detected), or — when none
 *      is reported and the detected isp is a satellite provider — `satellite`;
 *   6. `access` from the agent's stored classification (`access_class` +
 *      `access_reason`, written by the location check) — detected, with its
 *      reason (none when none is stored), on every job this function tags;
 *      never classified (or a value outside the closed set) →
 *      `access:unknown` "v1: not-classified";
 *   7. `sim` from the agent's stored SIM match (`sim_carrier` + `sim_reason`,
 *      server/sim-carrier.ts) — phone jobs only, and only when there is a
 *      carrier (a mismatch or a missing side is no tag, never a guess).
 *
 * `access` and `sim` are system-only (shared/tags.ts SYSTEM_TAG_KEYS): a
 * hand-set one can't be saved, and one found on a stored flow snapshot or
 * agent row (data from before the keys were reserved) is dropped here.
 *
 * A key may appear more than once (e.g. hand-set and detected `isp`): both
 * are kept so a board's value rule (`effectiveTags`) can change later without
 * rewriting history. Hand-set values read from jsonb (the snapshot's flow
 * tags, the agent's tags) and the lookup's `line` are re-validated with
 * `normalizeTag`, so a malformed stored entry is dropped rather than frozen;
 * the detected `isp` comes from `ispFromAsn`, which only ever returns a valid
 * value (or none), and `link` is checked against `LINK_VALUES`.
 *
 * An analysis (`kind = 'analyze'`) gets no tags at all: it analyses a
 * recording someone uploaded, so the claiming agent's vantage point (isp,
 * link, hand-set tags) says nothing about the path that recording traveled —
 * the same reason the claim nulls an analysis's site_id.
 */
import { normalizeTag, ispFromAsn, isSatelliteIsp, isSystemKey, LINK_VALUES, ACCESS_VALUES, type JobTag, type Tag, type LineLookup } from "@shared/tags";
import { lookupAsn, type AsnLookup } from "./location";

export type AsnLookupFn = (ip: string) => AsnLookup | null;

export interface JobTagsInput {
  /** The claimed job's own row: `kind` and its stamped `transport` (never the live flow's). */
  job: { kind: string; transport: string };
  /** `snapshot.evalFlow` of the job being claimed; tags/lineLookup are absent on pre-release snapshots. */
  snapshotFlow: { tags?: Tag[] | null; lineLookup?: LineLookup | null } | null | undefined;
  /** The claiming agent's row. `observedIp` is Core-internal — used here, never returned. */
  agent: {
    tags: unknown;
    linkType: string | null | undefined;
    observedIp: string | null | undefined;
    /** System-only columns (eval_agents.access_class/access_reason, sim_carrier/sim_reason). */
    accessClass?: string | null;
    accessReason?: string | null;
    simCarrier?: string | null;
    simReason?: string | null;
  };
}

/** The reason frozen with `access:unknown` for an agent the location check never classified. */
export const NOT_CLASSIFIED_REASON = "v1: not-classified";

function validTags(raw: unknown): Tag[] {
  if (!Array.isArray(raw)) return [];
  const out: Tag[] = [];
  for (const item of raw) {
    const t = normalizeTag(item as Tag);
    // System keys are never hand-set; a legacy stored one is not frozen.
    if (!("error" in t) && !isSystemKey(t.key)) out.push(t);
  }
  return out;
}

export function buildJobTags(input: JobTagsInput, asnLookup: AsnLookupFn = lookupAsn): JobTag[] {
  if (input.job.kind === "analyze") return [];
  const tags: JobTag[] = [];
  const flow = input.snapshotFlow ?? null;

  for (const t of validTags(flow?.tags)) tags.push({ ...t, source: "flow" });

  const lineValue = flow?.lineLookup?.value;
  if (input.job.transport === "phone" && typeof lineValue === "string") {
    const line = normalizeTag({ key: "line", value: lineValue });
    if (!("error" in line)) tags.push({ ...line, source: "detected" });
  }

  for (const t of validTags(input.agent.tags)) tags.push({ ...t, source: "agent" });

  let isp: string | undefined;
  if (input.agent.observedIp) {
    const asn = asnLookup(input.agent.observedIp);
    if (asn) isp = ispFromAsn(asn.asn, asn.org);
  }
  if (isp) tags.push({ key: "isp", value: isp, source: "detected" });

  const linkType = input.agent.linkType;
  if (linkType && (LINK_VALUES as readonly string[]).includes(linkType)) {
    tags.push({ key: "link", value: linkType, source: "detected" });
  } else if (isSatelliteIsp(isp)) {
    tags.push({ key: "link", value: "satellite", source: "detected" });
  }

  const accessClass = input.agent.accessClass;
  if (accessClass && (ACCESS_VALUES as readonly string[]).includes(accessClass)) {
    // A classified agent's reason is frozen as stored; none stored → no
    // reason (not-classified would contradict the class itself).
    tags.push({ key: "access", value: accessClass, source: "detected", ...(input.agent.accessReason ? { reason: input.agent.accessReason } : {}) });
  } else {
    tags.push({ key: "access", value: "unknown", source: "detected", reason: NOT_CLASSIFIED_REASON });
  }

  if (input.job.transport === "phone" && input.agent.simCarrier) {
    const sim = normalizeTag({ key: "sim", value: input.agent.simCarrier });
    if (!("error" in sim)) {
      tags.push({ ...sim, source: "detected", ...(input.agent.simReason ? { reason: input.agent.simReason } : {}) });
    }
  }

  return tags;
}
