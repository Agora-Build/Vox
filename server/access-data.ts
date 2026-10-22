/**
 * Network access data — the inputs the access classifier (last mile vs
 * datacenter) and the location pipeline's VPN/datacenter signal read.
 *
 * Sources (downloaded weekly by server/access-data-refresh.ts into
 * GEOIP_DB_DIR, next to the GeoIP databases):
 *   - X4BNet lists_vpn (MIT): datacenter + VPN CIDR lists, IPv4 and IPv6
 *   - client9/ipcat (MIT, archived 2023): datacenters.csv, IPv4 start,end ranges
 *   - APNIC Labs per-AS end-user estimates ("Re-use with attribution permitted")
 *   - PeeringDB `net` objects: NOT downloaded (its AUP forbids storing the data
 *     for commercial use without PeeringDB's approval). An operator who has that
 *     approval may place an export at GEOIP_DB_DIR/peeringdb-net.json; it is
 *     loaded when present.
 *   - Mobile-carrier ASNs: server/data/mobile-carrier-asns.json (curated, sourced).
 *
 * Missing data answers `false`/`undefined` and reports itself in `loaded` —
 * never a guess. Callers that must fail closed (location trust) check `loaded`.
 */
import path from "path";
import { promises as fsp } from "fs";
import { isIPv4, isIPv6 } from "net";

export type PeeringdbType = "access" | "content" | "enterprise" | "other";

export interface AccessDataLoaded {
  /** X4BNet datacenter IPv4 + IPv6 lists both loaded (ipcat is a supplement). */
  datacenter: boolean;
  /** X4BNet VPN IPv4 + IPv6 lists both loaded. */
  vpn: boolean;
  peeringdb: boolean;
  apnic: boolean;
  mobile: boolean;
}

export interface AccessData {
  isDatacenterIp(ip: string): boolean;
  isVpnIp(ip: string): boolean;
  peeringdbType(asn: number): PeeringdbType | undefined;
  /**
   * APNIC Labs estimate: the largest share (percent, 0–100) of any one
   * country's Internet users this AS serves. Undefined when APNIC has no row
   * for the AS or the data isn't loaded.
   */
  eyeballShare(asn: number): number | undefined;
  isMobileAsn(asn: number): boolean;
  readonly loaded: Readonly<AccessDataLoaded>;
}

// ==================== IP parsing ====================

// BigInt constants (tsconfig targets below ES2020, so no `123n` literals).
const N_0 = BigInt(0);
const N_1 = BigInt(1);
const N_16 = BigInt(16);
const N_32 = BigInt(32);
const N_128 = BigInt(128);
const N_XFFFF = BigInt(0xffff);
const N_XFFFFFFFF = BigInt(0xffffffff);


/** Strict dotted-quad → uint32, or null. */
export function ipv4ToInt(s: string): number | null {
  if (!isIPv4(s)) return null;
  const p = s.split(".");
  return (((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + +p[3]) >>> 0;
}

/** IPv6 (incl. embedded dotted-quad tail) → 128-bit bigint, or null. */
export function ipv6ToBigInt(input: string): bigint | null {
  if (!isIPv6(input)) return null;
  let s = input;
  if (s.includes(".")) {
    const idx = s.lastIndexOf(":");
    const v4 = ipv4ToInt(s.slice(idx + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, idx + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(":") : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let v = N_0;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    v = (v << N_16) | BigInt(parseInt(g, 16));
  }
  return v;
}

const V4_MAPPED_PREFIX = N_XFFFF;
const MAX_V6 = (N_1 << N_128) - N_1;

// ==================== Range sets ====================

export interface ParsedRanges {
  v4: Array<[number, number]>;
  v6: Array<[bigint, bigint]>;
  invalid: number;
}

/**
 * Sorted, merged, non-overlapping ranges with binary search. IPv4 in
 * Uint32Arrays; IPv6 in bigint arrays (lists are far smaller). `has()` never
 * throws: anything that isn't an IP is simply not a member.
 */
export class IpRangeSet {
  private constructor(
    private readonly v4Starts: Uint32Array,
    private readonly v4Ends: Uint32Array,
    private readonly v6Starts: bigint[],
    private readonly v6Ends: bigint[],
    /** Input range count (before merging). */
    readonly size: number,
  ) {}

  static fromRanges(v4: Array<[number, number]>, v6: Array<[bigint, bigint]>): IpRangeSet {
    const m4 = merge(v4.slice().sort((a, b) => a[0] - b[0]), (a, b) => a + 1 >= b);
    const m6 = merge(v6.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), (a, b) => a + N_1 >= b);
    return new IpRangeSet(
      Uint32Array.from(m4.map((r) => r[0])),
      Uint32Array.from(m4.map((r) => r[1])),
      m6.map((r) => r[0]),
      m6.map((r) => r[1]),
      v4.length + v6.length,
    );
  }

  static fromParsed(parts: ParsedRanges[]): IpRangeSet {
    return IpRangeSet.fromRanges(parts.flatMap((p) => p.v4), parts.flatMap((p) => p.v6));
  }

  has(ip: string): boolean {
    const v4 = ipv4ToInt(ip);
    if (v4 !== null) return this.has4(v4);
    const v6 = ipv6ToBigInt(ip);
    if (v6 === null) return false;
    if (v6 >> N_32 === V4_MAPPED_PREFIX) return this.has4(Number(v6 & N_XFFFFFFFF));
    return this.has6(v6);
  }

  private has4(x: number): boolean {
    const starts = this.v4Starts;
    let lo = 0, hi = starts.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] <= x) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found >= 0 && this.v4Ends[found] >= x;
  }

  private has6(x: bigint): boolean {
    const starts = this.v6Starts;
    let lo = 0, hi = starts.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] <= x) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found >= 0 && this.v6Ends[found] >= x;
  }
}

function merge<T extends number | bigint>(sorted: Array<[T, T]>, touches: (end: T, nextStart: T) => boolean): Array<[T, T]> {
  const out: Array<[T, T]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && touches(last[1], s)) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

// ==================== Parsers ====================

/** X4BNet lists_vpn format: one CIDR (or bare address) per line, `#` comments. */
export function parseCidrList(text: string): ParsedRanges {
  const out: ParsedRanges = { v4: [], v6: [], invalid: 0 };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const slash = line.indexOf("/");
    const addr = slash >= 0 ? line.slice(0, slash) : line;
    const prefixText = slash >= 0 ? line.slice(slash + 1) : null;
    if (prefixText !== null && !/^\d{1,3}$/.test(prefixText)) { out.invalid++; continue; }
    const v4 = ipv4ToInt(addr);
    if (v4 !== null) {
      const prefix = prefixText === null ? 32 : Number(prefixText);
      if (prefix > 32) { out.invalid++; continue; }
      const hostBits = 32 - prefix;
      const size = 2 ** hostBits;
      const start = Math.floor(v4 / size) * size; // mask host bits
      out.v4.push([start, start + size - 1]);
      continue;
    }
    const v6 = ipv6ToBigInt(addr);
    if (v6 !== null) {
      const prefix = prefixText === null ? 128 : Number(prefixText);
      if (prefix > 128) { out.invalid++; continue; }
      const hostMask = (N_1 << BigInt(128 - prefix)) - N_1;
      const start = v6 & (MAX_V6 ^ hostMask);
      out.v6.push([start, start | hostMask]);
      continue;
    }
    out.invalid++;
  }
  return out;
}

/** client9/ipcat datacenters.csv: `start,end,name,url` with inclusive dotted-quad bounds. */
export function parseIpcatCsv(text: string): ParsedRanges {
  const out: ParsedRanges = { v4: [], v6: [], invalid: 0 };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [a, b] = line.split(",");
    const start = ipv4ToInt((a ?? "").trim());
    const end = ipv4ToInt((b ?? "").trim());
    if (start === null || end === null || start > end) { out.invalid++; continue; }
    out.v4.push([start, end]);
  }
  return out;
}

/**
 * PeeringDB `net` objects (`{ data: [{ asn, info_type }] }`). Maps the
 * network's declared primary type; empty / "Not Disclosed" is no answer.
 */
export function parsePeeringdbNet(doc: unknown): Map<number, PeeringdbType> {
  const data = (doc as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("PeeringDB export has no data array");
  const out = new Map<number, PeeringdbType>();
  for (const row of data as Array<Record<string, unknown>>) {
    const asn = row?.asn;
    const type = row?.info_type;
    if (typeof asn !== "number" || !Number.isInteger(asn) || asn <= 0) continue;
    if (typeof type !== "string" || type === "" || type === "Not Disclosed") continue;
    out.set(asn,
      type === "Cable/DSL/ISP" ? "access"
        : type === "Content" ? "content"
          : type === "Enterprise" ? "enterprise"
            : "other");
  }
  return out;
}

/**
 * APNIC Labs aspop JSON (`cgi-bin/aspop?f=j`): one row per (AS, country).
 * Keeps, per AS, the largest "Percent of CC Pop".
 */
export function parseApnicAspop(doc: unknown): Map<number, number> {
  const data = (doc as { Data?: unknown } | null)?.Data;
  if (!Array.isArray(data)) throw new Error("APNIC aspop document has no Data array");
  const out = new Map<number, number>();
  for (const row of data as Array<Record<string, unknown>>) {
    const asn = row?.AS;
    const pct = row?.["Percent of CC Pop"];
    if (typeof asn !== "number" || !Number.isInteger(asn) || asn <= 0) continue;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0) continue;
    const prev = out.get(asn);
    if (prev === undefined || pct > prev) out.set(asn, pct);
  }
  return out;
}

/** server/data/mobile-carrier-asns.json: `{ "_comment": ..., "<asn>": { carrier, country, source } }`. */
export function parseMobileCarrierAsns(doc: unknown): Set<number> {
  const out = new Set<number>();
  if (!doc || typeof doc !== "object") return out;
  for (const key of Object.keys(doc)) {
    if (/^\d+$/.test(key)) out.add(Number(key));
  }
  return out;
}

// ==================== AccessData ====================

export interface AccessDataInputs {
  /** All datacenter range sources; `datacenterComplete` says the required ones were among them. */
  datacenter?: ParsedRanges[];
  vpn?: ParsedRanges[];
  datacenterComplete?: boolean;
  vpnComplete?: boolean;
  peeringdb?: Map<number, PeeringdbType>;
  apnic?: Map<number, number>;
  mobileAsns?: Set<number>;
}

/** Builds an AccessData from parsed inputs (fixtures in tests, files on disk in production). */
export function createAccessData(inputs: AccessDataInputs): AccessData {
  // A source that parsed to zero entries (an error page that slipped through,
  // an emptied file) is not loaded — counting it would turn off the
  // fail-closed cap while every lookup still answers "clean".
  const dc = inputs.datacenter ? IpRangeSet.fromParsed(inputs.datacenter) : null;
  const vpn = inputs.vpn ? IpRangeSet.fromParsed(inputs.vpn) : null;
  const loaded: AccessDataLoaded = {
    datacenter: dc !== null && dc.size > 0 && (inputs.datacenterComplete ?? true),
    vpn: vpn !== null && vpn.size > 0 && (inputs.vpnComplete ?? true),
    peeringdb: (inputs.peeringdb?.size ?? 0) > 0,
    apnic: (inputs.apnic?.size ?? 0) > 0,
    mobile: (inputs.mobileAsns?.size ?? 0) > 0,
  };
  return {
    isDatacenterIp: (ip) => dc?.has(ip) ?? false,
    isVpnIp: (ip) => vpn?.has(ip) ?? false,
    peeringdbType: (asn) => inputs.peeringdb?.get(asn),
    eyeballShare: (asn) => inputs.apnic?.get(asn),
    isMobileAsn: (asn) => inputs.mobileAsns?.has(asn) ?? false,
    loaded: Object.freeze(loaded),
  };
}

/**
 * The location pipeline's network class for one IP: "vpn" (anonymizer — VPN
 * checked first, since X4BNet's datacenter list includes VPN ranges too),
 * "hosting" (datacenter range or PeeringDB Content network), else null.
 * Callers must also check `data.loaded` — null from unloaded data is not "clean".
 */
export function networkClassOf(data: AccessData, ip: string, asn: number | undefined): "vpn" | "hosting" | null {
  if (data.isVpnIp(ip)) return "vpn";
  if (data.isDatacenterIp(ip)) return "hosting";
  if (asn !== undefined && data.peeringdbType(asn) === "content") return "hosting";
  return null;
}

// ==================== Disk loading ====================

/** File names inside GEOIP_DB_DIR. */
export const ACCESS_FILES = {
  datacenterV4: "access-datacenter-ipv4.txt",
  datacenterV6: "access-datacenter-ipv6.txt",
  vpnV4: "access-vpn-ipv4.txt",
  vpnV6: "access-vpn-ipv6.txt",
  ipcat: "access-ipcat-datacenters.csv",
  apnic: "access-apnic-aspop.json",
  /** Operator-supplied only — see the header comment. */
  peeringdb: "peeringdb-net.json",
  meta: "access-meta.json",
} as const;

export const MOBILE_CARRIER_ASNS_PATH = path.join(process.cwd(), "server/data/mobile-carrier-asns.json");

async function readOptional<T>(file: string, parse: (text: string) => T, label: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch {
    return undefined; // absent — that signal is simply missing
  }
  try {
    return parse(text);
  } catch (err) {
    console.warn(`[access-data] ${label} unreadable (${err instanceof Error ? err.message : String(err)}) — signal disabled`);
    return undefined;
  }
}

/** Reads whatever access data exists in `dir`; never throws. */
export async function loadAccessDataFromDir(dir: string, mobilePath: string = MOBILE_CARRIER_ASNS_PATH): Promise<AccessData> {
  const f = (name: string) => path.join(dir, name);
  const [rawDc4, rawDc6, rawVpn4, rawVpn6, rawIpcat, apnic, peeringdb, mobile] = await Promise.all([
    readOptional(f(ACCESS_FILES.datacenterV4), parseCidrList, "datacenter IPv4 list"),
    readOptional(f(ACCESS_FILES.datacenterV6), parseCidrList, "datacenter IPv6 list"),
    readOptional(f(ACCESS_FILES.vpnV4), parseCidrList, "VPN IPv4 list"),
    readOptional(f(ACCESS_FILES.vpnV6), parseCidrList, "VPN IPv6 list"),
    readOptional(f(ACCESS_FILES.ipcat), parseIpcatCsv, "ipcat datacenters"),
    readOptional(f(ACCESS_FILES.apnic), (t) => parseApnicAspop(JSON.parse(t)), "APNIC end-user estimates"),
    readOptional(f(ACCESS_FILES.peeringdb), (t) => parsePeeringdbNet(JSON.parse(t)), "PeeringDB export"),
    readOptional(mobilePath, (t) => parseMobileCarrierAsns(JSON.parse(t)), "mobile-carrier ASN list"),
  ]);
  const present = <T>(xs: Array<T | undefined>): T[] => xs.filter((x): x is T => x !== undefined);
  // A list file that parsed to zero ranges is as good as missing.
  const ranges = (p: ParsedRanges | undefined) => (p && p.v4.length + p.v6.length > 0 ? p : undefined);
  const [dc4, dc6, vpn4, vpn6, ipcat] = [rawDc4, rawDc6, rawVpn4, rawVpn6, rawIpcat].map(ranges);
  return createAccessData({
    datacenter: present([dc4, dc6, ipcat]),
    datacenterComplete: dc4 !== undefined && dc6 !== undefined,
    vpn: present([vpn4, vpn6]),
    vpnComplete: vpn4 !== undefined && vpn6 !== undefined,
    peeringdb,
    apnic,
    mobileAsns: mobile,
  });
}

// ==================== Live instance ====================

let current: AccessData = createAccessData({});

/** The live access data; swapped atomically by reloadAccessData(). */
export function getAccessData(): AccessData {
  return current;
}

/** Re-reads `dir` and swaps the live instance in one assignment. */
export async function reloadAccessData(dir: string): Promise<AccessData> {
  const next = await loadAccessDataFromDir(dir);
  current = next;
  return next;
}
