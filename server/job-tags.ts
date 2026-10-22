/**
 * The tags frozen onto `eval_jobs.tags` at claim
 * (designs/2026-10-22-network-tags-design.md "Detection", "Freezing at claim").
 *
 * Sources, in this order:
 *   1. the flow's hand-set tags — from the JOB's frozen snapshot, never the
 *      live flow (source "flow");
 *   2. `line` from the snapshot's number lookup (source "detected");
 *   3. the claiming agent's hand-set tags (source "agent");
 *   4. `isp` from the agent's observed IP via the ASN database (detected);
 *   5. `link` from the agent's reported link type (detected), or — when none
 *      is reported and the detected isp is a satellite provider — `satellite`.
 *
 * A key may appear more than once (e.g. hand-set and detected `isp`): both
 * are kept so a board's value rule (`effectiveTags`) can change later without
 * rewriting history. Stored values are re-validated with `normalizeTag`, so a
 * malformed jsonb entry is dropped rather than frozen.
 */
import { normalizeTag, ispFromAsn, isSatelliteIsp, LINK_VALUES, type JobTag, type Tag, type LineLookup } from "@shared/tags";
import { lookupAsn, type AsnLookup } from "./location";

export type AsnLookupFn = (ip: string) => AsnLookup | null;

export interface JobTagsInput {
  /** `snapshot.evalFlow` of the job being claimed; tags/lineLookup are absent on pre-release snapshots. */
  snapshotFlow: { tags?: Tag[] | null; lineLookup?: LineLookup | null } | null | undefined;
  /** The claiming agent's row. `observedIp` is Core-internal — used here, never returned. */
  agent: { tags: unknown; linkType: string | null | undefined; observedIp: string | null | undefined };
}

function validTags(raw: unknown): Tag[] {
  if (!Array.isArray(raw)) return [];
  const out: Tag[] = [];
  for (const item of raw) {
    const t = normalizeTag(item as Tag);
    if (!("error" in t)) out.push(t);
  }
  return out;
}

export function buildJobTags(input: JobTagsInput, asnLookup: AsnLookupFn = lookupAsn): JobTag[] {
  const tags: JobTag[] = [];
  const flow = input.snapshotFlow ?? null;

  for (const t of validTags(flow?.tags)) tags.push({ ...t, source: "flow" });

  const lineValue = flow?.lineLookup?.value;
  if (typeof lineValue === "string") {
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

  return tags;
}
