/**
 * Network tags — the pure tag model shared by the client, Core and the eval
 * agent, so they can't disagree (the `shared/placeholders.ts` pattern).
 * Design: designs/2026-10-22-network-tags-design.md ("Tag format",
 * "Detection", "Which value a board uses").
 *
 * A tag is `key:value`: which network path a result traveled, e.g. `line:twilio`
 * (the target's phone provider), `isp:starlink` / `link:wifi` (our eval agent's
 * vantage point). Both parts are trimmed, lowercased, and inner whitespace
 * becomes `-`. Known keys get suggestions and (for `link`) a closed set;
 * custom keys (`codec:opus`) are free-form and filterable, no suggestions.
 *
 * Dependency-free: imported by the client form, Core's save/claim routes and
 * the eval agent.
 */

/** Keys with suggestions / special handling. Any other key is a free custom key. */
export const KNOWN_TAG_KEYS = ["line", "isp", "link", "access", "sim"] as const;

/**
 * Keys only Vox sets — never by hand, on neither end (design "Last mile vs
 * datacenter" and "`sim` is system-only"). `access` comes from the location
 * check's classifier, `sim` from matching the phone's SIM operator against a
 * lookup of our own number. Both are frozen at claim as `detected` tags, and
 * every board reads only that detected value.
 */
export const SYSTEM_TAG_KEYS = ["access", "sim"] as const;

/** `access` is a closed set — the classifier's three answers. */
export const ACCESS_VALUES = ["lastmile", "datacenter", "unknown"] as const;
export type AccessClass = (typeof ACCESS_VALUES)[number];

/**
 * Which end of the path a tag describes — and so where it may be set by hand.
 * A flow describes the TARGET's side (`line`: its dialled number's provider);
 * an eval agent describes OUR vantage point (`isp`, `link`). A known key is
 * refused on the other end at save, a system key on both; custom keys are
 * allowed on both.
 */
export type TagEnd = "flow" | "agent";

/** Known keys each end may carry by hand. */
export const END_TAG_KEYS: Record<TagEnd, readonly string[]> = {
  flow: ["line"],
  agent: ["isp", "link"],
};

const SYSTEM_KEY_ERRORS: Record<(typeof SYSTEM_TAG_KEYS)[number], string> = {
  access: "access is set by Vox from the eval agent's network — it can't be set by hand",
  sim: "sim is detected from the phone's SIM and its number — it can't be set by hand",
};

export const isSystemKey = (key: string): key is (typeof SYSTEM_TAG_KEYS)[number] =>
  (SYSTEM_TAG_KEYS as readonly string[]).includes(key);

/** Why a known key can't be set on this end, or undefined when it can. */
export function tagEndError(key: string, end: TagEnd): string | undefined {
  if (isSystemKey(key)) return SYSTEM_KEY_ERRORS[key];
  if (!isKnownKey(key) || END_TAG_KEYS[end].includes(key)) return undefined;
  if (end === "flow") {
    return `${key} is detected from the eval agent's network — set it on the agent, not the flow`;
  }
  return `line belongs to the eval flow's dialled number — set it on the flow, not the agent`;
}

/**
 * The value every metrics `groupBy` uses for results WITHOUT the key, so no
 * tag may carry it — a real `isp:untagged` would be indistinguishable.
 */
export const UNTAGGED_VALUE = "untagged";

/** `link` is a closed set — a network link type isn't a matter of opinion. */
export const LINK_VALUES = ["wifi", "ethernet", "cellular", "satellite"] as const;

/** A valid `link` value — what the agent's own detection (Task 7) reports. */
export type LinkType = (typeof LINK_VALUES)[number];

/** At most this many tags on a flow / agent / job — a tag field isn't free text. */
export const MAX_TAGS = 16;

/** Key: `[a-z]` then up to 23 more `[a-z0-9-]`. */
const KEY_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/** Value: `[a-z0-9]` then up to 47 more `[a-z0-9.-]`. */
const VALUE_PATTERN = /^[a-z0-9][a-z0-9.-]{0,47}$/;

/**
 * Where a tag on a job came from — frozen at claim (one key may appear more
 * than once, e.g. both `detected` and hand-set, so a board's rule can change
 * later without rewriting history; see `effectiveTags` below).
 */
export type TagSource = "flow" | "agent" | "detected";

export interface Tag {
  key: string;
  value: string;
}

/**
 * A tag as frozen on a job at claim time. `reason` is carried by system tags
 * (`access`, `sim`): the classifier version + deciding signals, frozen with
 * the value so a result can always say why. Boards ignore it.
 */
export interface JobTag extends Tag {
  source: TagSource;
  reason?: string;
}

/**
 * The number lookup's answer for a flow's dialled number ("Number lookup"
 * section): value is the mapped `line` tag value, carrierName/lineType are
 * the provider's raw answer (kept for display, not a tag in v1), lookedUpAt
 * is when it ran, and number is the dialled number REDACTED to its last 4
 * digits (e.g. "…1234") — the full number never leaves `number_lookups`.
 * Stored on `eval_flows.line_lookup`; null = never looked up.
 */
export interface LineLookup {
  value: string;
  carrierName: string | null;
  lineType: string | null;
  lookedUpAt: string;
  number: string;
}

/** Which board is reading a job's tags — each has its own effective-value rule. */
export type TagBoard = "mainline" | "community" | "myEvals";

/** Suggested values for known keys with a natural "pick one" list (not `link`, which is closed). */
export const TAG_SUGGESTIONS: Record<"line" | "isp" | "sim", string[]> = {
  line: ["twilio", "bandwidth", "telnyx", "vonage", "plivo", "sinch", "signalwire"],
  isp: ["starlink", "att", "comcast", "verizon", "t-mobile", "aws", "gcp", "azure"],
  sim: ["att", "verizon", "t-mobile"],
};

const isKnownKey = (key: string): boolean => (KNOWN_TAG_KEYS as readonly string[]).includes(key);

/** trim → lowercase → inner whitespace runs → single `-`. Shared by key and value normalization. */
function normalizePart(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Normalize a free-form name (an ASN org, a carrier name) into a value this
 * module would accept — or `undefined` when there's nothing sane to keep.
 * lowercase → strip anything outside `[a-z0-9.- ]` → whitespace → `-` →
 * collapse repeated `-`/`.` → trim a leading non-alnum (the value regex
 * requires one) → cut to 48 chars → must still satisfy VALUE_PATTERN.
 */
function normalizeFreeValue(input: string | null | undefined): string | undefined {
  if (input == null) return undefined;
  let s = input.toLowerCase();
  s = s.replace(/[^a-z0-9.\- ]/g, "");
  s = s.replace(/\s+/g, "-");
  s = s.replace(/-+/g, "-").replace(/\.+/g, ".");
  s = s.replace(/^[^a-z0-9]+/, "");
  s = s.slice(0, 48);
  return VALUE_PATTERN.test(s) ? s : undefined;
}

/**
 * Normalize and validate one tag, from a `"key:value"` string or a
 * `{key, value}` object (e.g. `"Line : Twilio "` → `{key:"line",value:"twilio"}`).
 * Enforces the key/value syntax and, for `link`, the closed set.
 */
export function normalizeTag(raw: string | Tag): Tag | { error: string } {
  let keyRaw: unknown;
  let valueRaw: unknown;
  if (typeof raw === "string") {
    const idx = raw.indexOf(":");
    if (idx < 0) return { error: `Tag must be "key:value": "${raw}"` };
    keyRaw = raw.slice(0, idx);
    valueRaw = raw.slice(idx + 1);
  } else if (raw && typeof raw === "object") {
    keyRaw = raw.key;
    valueRaw = raw.value;
  } else {
    return { error: "Tag must be a string or {key, value}" };
  }
  if (typeof keyRaw !== "string" || typeof valueRaw !== "string") {
    return { error: "Tag key and value must both be strings" };
  }
  const key = normalizePart(keyRaw);
  const value = normalizePart(valueRaw);
  if (!KEY_PATTERN.test(key)) {
    return {
      error: `Invalid tag key "${keyRaw.trim()}": must start with a letter and contain only lowercase letters, digits and hyphens, up to 24 characters`,
    };
  }
  if (!VALUE_PATTERN.test(value)) {
    return {
      error: `Invalid tag value "${valueRaw.trim()}" for "${key}": must start with a letter or digit and contain only lowercase letters, digits, "." and "-", up to 48 characters`,
    };
  }
  if (value === UNTAGGED_VALUE) {
    return { error: `"${UNTAGGED_VALUE}" is reserved for results without the tag — use another value for "${key}"` };
  }
  if (key === "link" && !(LINK_VALUES as readonly string[]).includes(value)) {
    return { error: `Invalid value "${value}" for "link": must be one of ${LINK_VALUES.join(", ")}` };
  }
  if (key === "access" && !(ACCESS_VALUES as readonly string[]).includes(value)) {
    return { error: `Invalid value "${value}" for "access": must be one of ${ACCESS_VALUES.join(", ")}` };
  }
  return { key, value };
}

/**
 * Normalize a whole tag list: strings or `{key,value}` objects, deduped by
 * key (last one wins), capped at `MAX_TAGS` distinct keys. Any invalid entry
 * fails the whole list — a flow/agent either saves cleanly or not at all.
 * With `end`, a known key belonging to the other end is refused too
 * (`tagEndError`); without it (e.g. a list already stored) every key passes.
 */
export function parseTags(raw: unknown, opts: { end?: TagEnd } = {}): { tags: Tag[] } | { error: string } {
  if (raw == null) return { tags: [] };
  if (!Array.isArray(raw)) return { error: "Tags must be an array" };
  const byKey = new Map<string, string>();
  for (const item of raw) {
    if (typeof item !== "string" && !(item && typeof item === "object")) {
      return { error: `Invalid tag: ${JSON.stringify(item)}` };
    }
    const t = normalizeTag(item as string | Tag);
    if ("error" in t) return t;
    if (opts.end) {
      const endError = tagEndError(t.key, opts.end);
      if (endError) return { error: endError };
    }
    byKey.set(t.key, t.value); // Map.set on an existing key keeps its original position — "last wins" on value only.
  }
  if (byKey.size > MAX_TAGS) return { error: `Too many tags: at most ${MAX_TAGS} allowed` };
  return { tags: Array.from(byKey, ([key, value]) => ({ key, value })) };
}

/** `{key:"line",value:"twilio"}` → `"line:twilio"`. */
export function formatTag(t: Tag): string {
  return `${t.key}:${t.value}`;
}

/**
 * Known ASNs → a clean `isp` value. An ASN marked `satellite` drives
 * `isSatelliteIsp` below — it's the only way "no interface reports satellite"
 * (see the design's Detection section) still gets a `link:satellite`.
 */
const ASN_ISP_MAP: Record<number, { value: string; satellite?: boolean }> = {
  14593: { value: "starlink", satellite: true },
  7018: { value: "att" },
  7922: { value: "comcast" },
  701: { value: "verizon" },
  21928: { value: "t-mobile" },
  16509: { value: "aws" },
  15169: { value: "gcp" },
  8075: { value: "azure" },
};

const SATELLITE_ISP_VALUES = new Set(
  Object.values(ASN_ISP_MAP)
    .filter((e) => e.satellite)
    .map((e) => e.value),
);

/**
 * `isp` from the agent's observed-IP ASN lookup (`server/location.ts`'s
 * `AsnLookup`, passed in as plain fields so this module stays dependency-free).
 * A mapped ASN wins outright; otherwise the org name, normalized; otherwise
 * `undefined` (no ASN database / no IP).
 */
export function ispFromAsn(asn: number | undefined, org: string | undefined): string | undefined {
  if (asn !== undefined && ASN_ISP_MAP[asn]) return ASN_ISP_MAP[asn].value;
  return normalizeFreeValue(org);
}

/** Carrier-name substrings (case-insensitive) → a clean `line` value. */
const CARRIER_LINE_MAP: Array<[RegExp, string]> = [
  [/twilio/i, "twilio"],
  [/bandwidth/i, "bandwidth"],
  [/telnyx/i, "telnyx"],
  [/vonage|nexmo/i, "vonage"],
  [/plivo/i, "plivo"],
  [/sinch/i, "sinch"],
  [/signalwire/i, "signalwire"],
];

/**
 * `line` from a Twilio Lookup `carrier_name` (or a future provider's
 * equivalent). A known carrier wins outright; otherwise the name, normalized;
 * `null`/`undefined` (no carrier — e.g. toll-free) → `undefined`.
 */
export function lineFromCarrier(carrierName: string | null | undefined): string | undefined {
  if (carrierName == null) return undefined;
  for (const [pattern, value] of CARRIER_LINE_MAP) {
    if (pattern.test(carrierName)) return value;
  }
  return normalizeFreeValue(carrierName);
}

/**
 * Carrier-name substrings (case-insensitive) → the RADIO network a SIM rides
 * on. A lookup of an MVNO's number (Mint, Visible, Cricket…) reports the host
 * network's carrier, so this names the network the call actually used.
 */
const CARRIER_SIM_MAP: Array<[RegExp, string]> = [
  [/t-?mobile|sprint/i, "t-mobile"],
  [/at&t|at & t|cingular/i, "att"],
  [/verizon|cellco/i, "verizon"],
];

/**
 * `sim` from the number lookup's carrier name for our own SIM's number. A
 * known network wins; otherwise the name, normalized; none → `undefined`.
 */
export function simFromCarrier(carrierName: string | null | undefined): string | undefined {
  if (carrierName == null) return undefined;
  for (const [pattern, value] of CARRIER_SIM_MAP) {
    if (pattern.test(carrierName)) return value;
  }
  return normalizeFreeValue(carrierName);
}

/** Whether an `isp` value is a satellite provider — used to infer `link:satellite` when no interface can report it. */
export function isSatelliteIsp(isp: string | undefined): boolean {
  return !!isp && SATELLITE_ISP_VALUES.has(isp);
}

/**
 * The effective value of a job's tags, per board rule
 * (designs/2026-10-22-network-tags-design.md "Which value a board uses"):
 *
 * - **mainline**: for `line`/`isp`/`link`/`sim`, the **detected** value; a
 *   hand-set-only value counts as untagged. Exception: `line` on a job with
 *   no detected `line` (no lookup — missing credentials, toll-free, a secret
 *   number) falls back to the flow's hand-set value, since the flow is the
 *   owner's own claim anyway. Custom keys use the flow/agent value, agent
 *   overriding flow.
 * - **community / myEvals**: the hand-set value when there is one (agent
 *   overriding flow), else the detected one.
 * - **system keys** (`access`, `sim`), on every board: the detected value
 *   only. No route can store a hand-set one; any that turns up is ignored.
 *
 * "The flow had a lookup" is derived from the job's own tags — a `line` tag
 * with `source: "detected"` — never a separate flag, because the SQL side
 * (the generated jsonb predicate) only ever sees the frozen job tags too.
 */
export function effectiveTags(jobTags: JobTag[] | null | undefined, board: TagBoard): Tag[] {
  const tags = jobTags ?? [];
  const byKey = new Map<string, JobTag[]>();
  for (const t of tags) {
    const list = byKey.get(t.key);
    if (list) list.push(t);
    else byKey.set(t.key, [t]);
  }
  const hasDetectedLine = (byKey.get("line") ?? []).some((t) => t.source === "detected");

  const result: Tag[] = [];
  byKey.forEach((list, key) => {
    const detected = list.find((t) => t.source === "detected");
    const agent = list.find((t) => t.source === "agent");
    const flow = list.find((t) => t.source === "flow");

    let value: string | undefined;
    if (isSystemKey(key)) {
      value = detected?.value;
    } else if (board === "mainline") {
      if (detected) {
        value = detected.value;
      } else if (key === "line" && !hasDetectedLine && flow) {
        value = flow.value;
      } else if (!isKnownKey(key)) {
        value = agent?.value ?? flow?.value;
      }
      // Known keys (isp/link) with no detected value, and no exception
      // above, stay untagged by design — a hand-set-only value on a public
      // agent must not be able to mislabel results others rely on.
    } else {
      value = agent?.value ?? flow?.value ?? detected?.value;
    }

    if (value !== undefined) result.push({ key, value });
  });
  return result;
}

/**
 * Parse the `tag` query parameter (a single string, or repeated → an array)
 * into the list of filters a metrics endpoint must AND-match. Absent → no
 * filters, not an error.
 */
export function parseTagFilter(raw: unknown): { filters: Tag[] } | { error: string } {
  if (raw == null) return { filters: [] };
  const items = Array.isArray(raw) ? raw : [raw];
  const filters: Tag[] = [];
  for (const item of items) {
    if (typeof item !== "string") return { error: `Invalid tag filter: ${JSON.stringify(item)}` };
    const t = normalizeTag(item);
    if ("error" in t) return t;
    filters.push(t);
  }
  return { filters };
}

/**
 * Parse the `groupBy` query parameter — a single key (known or custom),
 * normalized the same way a tag's key is. Absent → no grouping, not an error.
 */
export function parseGroupBy(raw: unknown): { groupBy?: string } | { error: string } {
  if (raw == null || raw === "") return {};
  if (Array.isArray(raw)) return { error: "groupBy must be a single key, not a list" };
  if (typeof raw !== "string") return { error: "groupBy must be a string" };
  const key = normalizePart(raw);
  if (!KEY_PATTERN.test(key)) {
    return { error: `Invalid groupBy key "${raw.trim()}": must start with a letter and contain only lowercase letters, digits and hyphens, up to 24 characters` };
  }
  return { groupBy: key };
}
