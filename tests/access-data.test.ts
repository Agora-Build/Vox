import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, promises as fsp } from "fs";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import path from "path";
import { tmpdir } from "os";
import {
  IpRangeSet,
  parseCidrList,
  parseIpcatCsv,
  parsePeeringdbNet,
  parseApnicAspop,
  APNIC_MIN_COUNTRY_USERS,
  parseMobileCarrierAsns,
  createAccessData,
  loadAccessDataFromDir,
  ACCESS_FILES,
  v4CoverageShare,
  v6CoverageShare,
} from "../server/access-data";
import {
  refreshAccessData, ACCESS_SOURCES, accessDataNeedsRefresh, accessRetryDelayMs, scheduleAccessRetry, type AccessSource,
  downloadAccessFile, MAX_VPN_V4_SHARE, MAX_DATACENTER_V4_SHARE, MAX_VPN_V6_SHARE, MAX_DATACENTER_V6_SHARE,
} from "../server/access-data-refresh";

const FIX = path.join(__dirname, "fixtures/access");
const fixture = (name: string) => readFileSync(path.join(FIX, name), "utf8");

describe("parseCidrList (X4BNet lists_vpn format)", () => {
  it("parses IPv4 CIDRs and bare addresses, skipping comments and invalid lines", () => {
    const parsed = parseCidrList(fixture("x4bnet-ipv4.txt"));
    expect(parsed.v4.length).toBe(4);
    expect(parsed.v6.length).toBe(0);
    // "not-a-cidr" and "10.0.0.0/33" (prefix out of range)
    expect(parsed.invalid).toBe(2);
    const set = IpRangeSet.fromParsed([parsed]);
    expect(set.has("3.1.255.255")).toBe(true);
    expect(set.has("3.2.0.0")).toBe(false);
    expect(set.has("203.0.113.7")).toBe(true);
    expect(set.has("203.0.113.8")).toBe(false);
    expect(set.has("10.0.0.1")).toBe(false);
  });
  it("masks host bits beyond the prefix (198.51.100.77/24 covers the whole /24)", () => {
    const set = IpRangeSet.fromParsed([parseCidrList("198.51.100.77/24\n")]);
    expect(set.has("198.51.100.0")).toBe(true);
    expect(set.has("198.51.100.255")).toBe(true);
    expect(set.has("198.51.101.0")).toBe(false);
  });
  it("parses IPv6 CIDRs, skipping invalid lines", () => {
    const parsed = parseCidrList(fixture("x4bnet-ipv6.txt"));
    expect(parsed.v6.length).toBe(2);
    expect(parsed.invalid).toBe(2); // bad hex group, /129
    const set = IpRangeSet.fromParsed([parsed]);
    expect(set.has("2001:db8::1")).toBe(true);
    expect(set.has("2001:db8:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
    expect(set.has("2001:db9::")).toBe(false);
    expect(set.has("2600:1fff::1")).toBe(true);
    expect(set.has("2601::1")).toBe(false);
  });
  it("an HTML error page parses to zero ranges", () => {
    const parsed = parseCidrList("<html><body>404: Not Found</body></html>\n");
    expect(parsed.v4.length + parsed.v6.length).toBe(0);
  });
});

// A `0.0.0.0/0` (or /1) line in the VPN list would mark every IP vpn →
// anonymized → every region cleared. No real range is wider than /9 (v4) or
// /24 (v6) in today's data; anything wider than /8 or /16 is dropped.
describe("over-broad ranges are dropped as invalid", () => {
  it("IPv4 prefixes shorter than /8 are invalid; /8 itself is kept", () => {
    const parsed = parseCidrList("0.0.0.0/0\n128.0.0.0/1\n10.0.0.0/7\n44.0.0.0/8\n203.0.113.0/24\n");
    expect(parsed.invalid).toBe(3);
    const set = IpRangeSet.fromParsed([parsed]);
    expect(set.has("8.8.8.8")).toBe(false);
    expect(set.has("200.1.2.3")).toBe(false);
    expect(set.has("44.200.0.1")).toBe(true);
    expect(set.has("203.0.113.9")).toBe(true);
  });
  it("IPv6 prefixes shorter than /16 are invalid; /16 itself is kept", () => {
    const parsed = parseCidrList("::/0\n2000::/3\n2a00::/15\n2a0d::/16\n");
    expect(parsed.invalid).toBe(3);
    const set = IpRangeSet.fromParsed([parsed]);
    expect(set.has("2601:646::1")).toBe(false);
    expect(set.has("2a0d:1::1")).toBe(true);
  });
  it("an ipcat row wider than a /8 is invalid", () => {
    const parsed = parseIpcatCsv("0.0.0.0,255.255.255.255,Everything,x\n3.0.0.0,3.255.255.255,AWS,x\n");
    expect(parsed.invalid).toBe(1);
    expect(parsed.v4).toEqual([[0x03000000, 0x03ffffff]]);
  });
  it("a VPN list carrying 0.0.0.0/0 does not mark an ordinary address vpn", async () => {
    const dir = await fsp.mkdtemp(path.join(tmpdir(), "access-broad-"));
    await fsp.writeFile(path.join(dir, ACCESS_FILES.vpnV4), "0.0.0.0/0\n198.18.0.0/15\n");
    await fsp.writeFile(path.join(dir, ACCESS_FILES.vpnV6), "::/0\n2a0d:5600::/29\n");
    const data = await loadAccessDataFromDir(dir);
    expect(data.isVpnIp("73.15.20.1")).toBe(false);
    expect(data.isVpnIp("2601:646::1")).toBe(false);
    expect(data.isVpnIp("198.19.0.1")).toBe(true);
  });
});

describe("v4CoverageShare", () => {
  it("is the merged share of the IPv4 space, overlaps counted once", () => {
    expect(v4CoverageShare(parseCidrList("10.0.0.0/8\n10.1.0.0/16\n11.0.0.0/8\n"))).toBeCloseTo(2 / 256, 10);
    expect(v4CoverageShare(parseCidrList(""))).toBe(0);
  });
});

describe("v6CoverageShare", () => {
  it("is the merged share of 2000::/3, overlaps counted once, outside 2000::/3 ignored", () => {
    // A /16 inside 2000::/3 is 2^-13 of it; a nested /32 adds nothing.
    expect(v6CoverageShare(parseCidrList("2a00::/16\n2a00:1::/32\n"))).toBeCloseTo(2 ** -13, 12);
    // fc00::/7 (ULA) and ::/16 lie outside 2000::/3 and don't count.
    expect(v6CoverageShare(parseCidrList("fc00::/16\n0::/16\n"))).toBe(0);
    expect(v6CoverageShare(parseCidrList("2a00::/16\n2b00::/16\n"))).toBeCloseTo(2 * 2 ** -13, 12);
    expect(v6CoverageShare(parseCidrList(""))).toBe(0);
  });
});

describe("parseIpcatCsv (client9/ipcat datacenters.csv)", () => {
  it("parses inclusive start,end ranges and skips backwards/garbage rows", () => {
    const parsed = parseIpcatCsv(fixture("ipcat-datacenters.csv"));
    expect(parsed.v4.length).toBe(2);
    expect(parsed.invalid).toBe(2);
    const set = IpRangeSet.fromParsed([parsed]);
    expect(set.has("192.0.2.10")).toBe(true);
    expect(set.has("192.0.2.20")).toBe(true);
    expect(set.has("192.0.2.21")).toBe(false);
    expect(set.has("192.0.2.45")).toBe(false); // the backwards range is not loaded
  });
});

describe("parsePeeringdbNet (PeeringDB net objects)", () => {
  const types = parsePeeringdbNet(JSON.parse(fixture("peeringdb-net.json")));
  it("maps info_type to access/content/enterprise/other", () => {
    expect(types.get(7922)).toBe("access");
    expect(types.get(64500)).toBe("content");
    expect(types.get(16509)).toBe("enterprise");
    expect(types.get(64501)).toBe("other");
  });
  it("undisclosed or empty info_type is no answer, not 'other'", () => {
    expect(types.has(22394)).toBe(false);
    expect(types.has(64502)).toBe(false);
  });
  it("rejects a document without a data array", () => {
    expect(() => parsePeeringdbNet({ error: "rate limited" })).toThrow();
  });
});

describe("parseApnicAspop (APNIC per-AS end-user estimates)", () => {
  const shares = parseApnicAspop(JSON.parse(fixture("apnic-aspop.json")));
  it("keeps each AS's largest share of a country's users, counting only countries with ≥ APNIC_MIN_COUNTRY_USERS", () => {
    expect(APNIC_MIN_COUNTRY_USERS).toBe(500_000);
    expect(shares.get(7922)).toBeCloseTo(17.89);
    // T-Mobile's PR row (9.10%) serves only 100k users — a small-country share
    // isn't evidence (Cloudflare reads 32% of Antarctica's 207 users) — so the
    // US row's 7.56% stands.
    expect(shares.get(21928)).toBeCloseTo(7.56);
    // Known to APNIC but never big anywhere → 0, not undefined.
    expect(shares.get(13335)).toBe(0);
  });
  it("keeps the max among qualifying rows regardless of order", () => {
    const row = (AS: number, Users: number, pct: number) => ({ AS, Users, "Percent of CC Pop": pct });
    const m = parseApnicAspop({ Data: [row(1, 600_000, 2), row(1, 9_000_000, 5), row(1, 700_000, 3)] });
    expect(m.get(1)).toBe(5);
  });
  it("skips malformed rows", () => {
    expect(shares.size).toBe(3);
  });
  it("rejects a document without a Data array", () => {
    expect(() => parseApnicAspop("<html>Nope</html>")).toThrow();
  });
});

describe("mobile-carrier-asns.json", () => {
  it("parses ASN keys and ignores _comment", () => {
    const set = parseMobileCarrierAsns({ _comment: "x", "21928": { carrier: "T-Mobile USA" }, abc: {} });
    expect([...set]).toEqual([21928]);
  });
  it("the shipped seed carries the four US carrier ASNs, each with a source", () => {
    const raw = JSON.parse(readFileSync(path.join(process.cwd(), "server/data/mobile-carrier-asns.json"), "utf8"));
    const set = parseMobileCarrierAsns(raw);
    for (const asn of [21928, 6167, 22394, 20057]) expect(set.has(asn)).toBe(true);
    expect(typeof raw._comment).toBe("string");
    for (const key of Object.keys(raw).filter((k) => k !== "_comment")) {
      expect(typeof raw[key].source).toBe("string");
      expect(raw[key].source.length).toBeGreaterThan(10);
    }
  });
});

describe("createAccessData", () => {
  const data = createAccessData({
    datacenter: [parseCidrList(fixture("x4bnet-ipv4.txt")), parseCidrList(fixture("x4bnet-ipv6.txt")), parseIpcatCsv(fixture("ipcat-datacenters.csv"))],
    vpn: [parseCidrList("198.18.0.0/15\n2a0d:5600::/29\n")],
    peeringdb: parsePeeringdbNet(JSON.parse(fixture("peeringdb-net.json"))),
    apnic: parseApnicAspop(JSON.parse(fixture("apnic-aspop.json"))),
    mobileAsns: new Set([21928]),
  });
  it("answers membership for each source", () => {
    expect(data.isDatacenterIp("3.0.0.1")).toBe(true);
    expect(data.isDatacenterIp("192.0.2.15")).toBe(true); // ipcat-only range
    expect(data.isDatacenterIp("2001:db8::5")).toBe(true);
    expect(data.isDatacenterIp("8.8.4.4")).toBe(false);
    expect(data.isVpnIp("198.19.1.1")).toBe(true);
    expect(data.isVpnIp("2a0d:5600::1")).toBe(true);
    expect(data.isVpnIp("3.0.0.1")).toBe(false);
    expect(data.peeringdbType(64500)).toBe("content");
    expect(data.eyeballShare(7922)).toBeCloseTo(17.89);
    expect(data.isMobileAsn(21928)).toBe(true);
    expect(data.isMobileAsn(7922)).toBe(false);
    expect(data.loaded).toEqual({ datacenter: true, vpn: true, peeringdb: true, apnic: true, mobile: true });
  });
  it("v4-mapped IPv6 addresses are looked up as IPv4", () => {
    expect(data.isDatacenterIp("::ffff:3.0.0.1")).toBe(true);
    expect(data.isDatacenterIp("::ffff:8.8.4.4")).toBe(false);
  });
  it("garbage input is never a member", () => {
    expect(data.isDatacenterIp("not-an-ip")).toBe(false);
    expect(data.isVpnIp("")).toBe(false);
  });
  it("missing data answers undefined/false and reports itself unloaded — never a false positive", () => {
    const empty = createAccessData({});
    expect(empty.isDatacenterIp("3.0.0.1")).toBe(false);
    expect(empty.isVpnIp("198.19.1.1")).toBe(false);
    expect(empty.peeringdbType(64500)).toBeUndefined();
    expect(empty.eyeballShare(7922)).toBeUndefined();
    expect(empty.isMobileAsn(21928)).toBe(false);
    expect(empty.loaded).toEqual({ datacenter: false, vpn: false, peeringdb: false, apnic: false, mobile: false });
  });
  it("inputs that parsed to zero entries do not count as loaded", () => {
    const hollow = createAccessData({
      datacenter: [parseCidrList("<html>404</html>")],
      vpn: [parseCidrList("")],
      peeringdb: new Map(),
      apnic: new Map(),
      mobileAsns: new Set(),
    });
    expect(hollow.loaded).toEqual({ datacenter: false, vpn: false, peeringdb: false, apnic: false, mobile: false });
  });
  it("an ASN absent from loaded data is undefined, not zero", () => {
    expect(data.eyeballShare(64999)).toBeUndefined();
    expect(data.peeringdbType(64999)).toBeUndefined();
  });
});

describe("range lookup performance", () => {
  it("10k lookups against 100k+ IPv4 and 100k IPv6 ranges finish fast", () => {
    const v4: Array<[number, number]> = [];
    for (let i = 0; i < 120_000; i++) {
      const start = (i * 35_791) >>> 0; // spread across the space, step > range width
      v4.push([start, start + 255]);
    }
    const v6: Array<[bigint, bigint]> = [];
    for (let i = 0; i < 100_000; i++) {
      const start = (0x2001n << 112n) + (BigInt(i) << 80n);
      v6.push([start, start + (1n << 64n) - 1n]);
    }
    const set = IpRangeSet.fromRanges(v4, v6);
    expect(set.size).toBe(220_000);
    const probes4: string[] = [];
    const probes6: string[] = [];
    for (let i = 0; i < 5_000; i++) {
      const n = ((i * 2_654_435_761) >>> 0);
      probes4.push(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
      probes6.push(`2001:${(i % 65536).toString(16)}::${i.toString(16)}`);
    }
    const t0 = performance.now();
    let hits = 0;
    for (const p of probes4) if (set.has(p)) hits++;
    for (const p of probes6) if (set.has(p)) hits++;
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200);
    // Sanity: the answers are right, not just fast.
    expect(set.has("0.0.0.255")).toBe(true);
    expect(set.has("0.0.1.0")).toBe(false);
    expect(set.has("2001:0:1::1")).toBe(true); // i=1 → the 2001:0:1::/64 range
    expect(hits).toBeGreaterThan(0);
  });
  it("overlapping and adjacent ranges merge correctly", () => {
    const set = IpRangeSet.fromRanges([[10, 20], [15, 30], [31, 40], [100, 100]], []);
    expect(set.has("0.0.0.10")).toBe(true);
    expect(set.has("0.0.0.25")).toBe(true);
    expect(set.has("0.0.0.40")).toBe(true);
    expect(set.has("0.0.0.41")).toBe(false);
    expect(set.has("0.0.0.9")).toBe(false);
    expect(set.has("0.0.0.100")).toBe(true);
    expect(set.has("0.0.0.99")).toBe(false);
  });
});

// ---------------- refresh (download path) ----------------

describe("refreshAccessData", () => {
  let server: Server;
  let base = "";
  let failing = new Set<string>();
  const routes: Record<string, string> = {
    "/dc4": fixture("x4bnet-ipv4.txt"),
    "/dc6": fixture("x4bnet-ipv6.txt"),
    "/vpn4": "198.18.0.0/15\n",
    "/vpn6": "2a0d:5600::/29\n",
    "/ipcat": fixture("ipcat-datacenters.csv"),
    "/apnic": fixture("apnic-aspop.json"),
    "/html": "<html>Nope. Not going to do this!</html>",
  };
  const sources = (): AccessSource[] => ACCESS_SOURCES.map((s) => ({
    ...s,
    url: `${base}${({ "datacenter-ipv4": "/dc4", "datacenter-ipv6": "/dc6", "vpn-ipv4": "/vpn4", "vpn-ipv6": "/vpn6", "ipcat": "/ipcat", "apnic": "/apnic" } as Record<string, string>)[s.id]}`,
    minEntries: 1,
  }));

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (failing.has(url)) { res.writeHead(500); res.end("boom"); return; }
      const body = routes[url];
      if (body === undefined) { res.writeHead(404); res.end(); return; }
      res.writeHead(200); res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function freshDir(): Promise<string> {
    return fsp.mkdtemp(path.join(tmpdir(), "access-data-"));
  }

  it("downloads every source, writes files and loads them", async () => {
    failing = new Set();
    const dir = await freshDir();
    const result = await refreshAccessData({ dir, sources: sources(), now: new Date("2026-10-22T00:00:00Z") });
    expect(result.ok).toBe(true);
    for (const s of ACCESS_SOURCES) expect(result.sources[s.id]?.ok).toBe(true);
    const data = await loadAccessDataFromDir(dir);
    expect(data.isDatacenterIp("3.0.0.1")).toBe(true);
    expect(data.isDatacenterIp("192.0.2.15")).toBe(true);
    expect(data.isVpnIp("198.19.0.1")).toBe(true);
    expect(data.eyeballShare(7922)).toBeCloseTo(17.89);
    expect(data.loaded.datacenter).toBe(true);
    expect(data.loaded.vpn).toBe(true);
    const meta = JSON.parse(await fsp.readFile(path.join(dir, ACCESS_FILES.meta), "utf8"));
    expect(meta.sources["datacenter-ipv4"].fetchedAt).toBe("2026-10-22T00:00:00.000Z");
    expect(accessDataNeedsRefresh(dir, new Date("2026-10-23T00:00:00Z"))).toBe(false);
    expect(accessDataNeedsRefresh(dir, new Date("2026-10-30T00:00:01Z"))).toBe(true);
  });

  it("a failed download keeps the previous copy and reports the failure", async () => {
    failing = new Set();
    const dir = await freshDir();
    await refreshAccessData({ dir, sources: sources(), now: new Date("2026-10-22T00:00:00Z") });
    failing = new Set(["/dc4"]);
    const result = await refreshAccessData({ dir, sources: sources(), now: new Date("2026-10-29T00:00:00Z") });
    expect(result.ok).toBe(false);
    expect(result.sources["datacenter-ipv4"]?.ok).toBe(false);
    expect(result.sources["datacenter-ipv4"]?.error).toMatch(/500/);
    expect(result.sources["vpn-ipv4"]?.ok).toBe(true);
    const data = await loadAccessDataFromDir(dir);
    expect(data.isDatacenterIp("3.0.0.1")).toBe(true); // old copy still there
    const meta = JSON.parse(await fsp.readFile(path.join(dir, ACCESS_FILES.meta), "utf8"));
    expect(meta.sources["datacenter-ipv4"].fetchedAt).toBe("2026-10-22T00:00:00.000Z");
    expect(meta.sources["vpn-ipv4"].fetchedAt).toBe("2026-10-29T00:00:00.000Z");
  });

  it("a download that doesn't parse (HTML error page) is rejected and never replaces the old copy", async () => {
    failing = new Set();
    const dir = await freshDir();
    await refreshAccessData({ dir, sources: sources(), now: new Date("2026-10-22T00:00:00Z") });
    const bad = sources().map((s) => (s.id === "datacenter-ipv4" || s.id === "apnic" ? { ...s, url: `${base}/html` } : s));
    const result = await refreshAccessData({ dir, sources: bad, now: new Date("2026-10-29T00:00:00Z") });
    expect(result.sources["datacenter-ipv4"]?.ok).toBe(false);
    expect(result.sources["apnic"]?.ok).toBe(false);
    const data = await loadAccessDataFromDir(dir);
    expect(data.isDatacenterIp("3.0.0.1")).toBe(true);
    expect(data.eyeballShare(7922)).toBeCloseTo(17.89);
    const leftovers = (await fsp.readdir(dir)).filter((f) => f.startsWith(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("a download below a source's minimum entry count is rejected", async () => {
    failing = new Set();
    const dir = await freshDir();
    const strict = sources().map((s) => (s.id === "vpn-ipv4" || s.id === "datacenter-ipv6" ? { ...s, minEntries: 1000 } : s));
    const result = await refreshAccessData({ dir, sources: strict, now: new Date("2026-10-22T00:00:00Z") });
    expect(result.sources["vpn-ipv4"]?.ok).toBe(false);
    expect(result.sources["datacenter-ipv6"]?.ok).toBe(false);
    const data = await loadAccessDataFromDir(dir);
    // One list of a pair missing ⇒ that data is not loaded (location trust stays capped)…
    expect(data.loaded.vpn).toBe(false);
    expect(data.loaded.datacenter).toBe(false);
    // …though the ranges that did load still answer.
    expect(data.isDatacenterIp("3.0.0.1")).toBe(true);
    expect(data.isVpnIp("2a0d:5600::1")).toBe(true);
  });

  // Thirteen /8s = 5.08% of the IPv4 space; fifty-two = 20.3%.
  const slash8s = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `${from + i}.0.0.0/8`).join("\n") + "\n";

  it("a VPN list covering more than its ceiling (5%) is refused and the previous copy kept", async () => {
    failing = new Set();
    const dir = await freshDir();
    await refreshAccessData({ dir, sources: sources(), now: new Date("2026-10-22T00:00:00Z") });
    routes["/vpn4-broad"] = slash8s(13, 60);
    try {
      const broad = sources().map((s) => (s.id === "vpn-ipv4" ? { ...s, url: `${base}/vpn4-broad` } : s));
      const result = await refreshAccessData({ dir, sources: broad, now: new Date("2026-10-29T00:00:00Z") });
      expect(MAX_VPN_V4_SHARE).toBe(0.05);
      expect(result.sources["vpn-ipv4"]?.ok).toBe(false);
      expect(result.sources["vpn-ipv4"]?.error).toMatch(/5\.1% of the IPv4 space, above the 5% ceiling/);
      const data = await loadAccessDataFromDir(dir);
      expect(data.isVpnIp("65.1.2.3")).toBe(false); // the broad list never landed
      expect(data.isVpnIp("198.19.0.1")).toBe(true); // the old copy still answers
    } finally {
      delete routes["/vpn4-broad"];
    }
  });

  it("a VPN list just under its ceiling is accepted", async () => {
    failing = new Set();
    const dir = await freshDir();
    routes["/vpn4-12"] = slash8s(12, 60); // 4.7%
    try {
      const ok = sources().map((s) => (s.id === "vpn-ipv4" ? { ...s, url: `${base}/vpn4-12` } : s));
      const result = await refreshAccessData({ dir, sources: ok, now: new Date("2026-10-22T00:00:00Z") });
      expect(result.sources["vpn-ipv4"]?.ok).toBe(true);
    } finally {
      delete routes["/vpn4-12"];
    }
  });

  it("a datacenter list (X4BNet or ipcat) covering more than 20% is refused", async () => {
    failing = new Set();
    const dir = await freshDir();
    routes["/dc4-broad"] = slash8s(52, 100);
    routes["/ipcat-broad"] = Array.from({ length: 52 }, (_, i) => `${100 + i}.0.0.0,${100 + i}.255.255.255,X,x`).join("\n") + "\n";
    try {
      const broad = sources().map((s) => (s.id === "datacenter-ipv4" ? { ...s, url: `${base}/dc4-broad` }
        : s.id === "ipcat" ? { ...s, url: `${base}/ipcat-broad` } : s));
      const result = await refreshAccessData({ dir, sources: broad, now: new Date("2026-10-22T00:00:00Z") });
      expect(MAX_DATACENTER_V4_SHARE).toBe(0.2);
      expect(result.sources["datacenter-ipv4"]?.ok).toBe(false);
      expect(result.sources["ipcat"]?.ok).toBe(false);
      expect(result.sources["datacenter-ipv4"]?.error).toMatch(/above the 20% ceiling/);
    } finally {
      delete routes["/dc4-broad"];
      delete routes["/ipcat-broad"];
    }
  });

  // n distinct /16s inside 2a00::/8 — each 2^-13 (0.0122%) of 2000::/3.
  const v6Slash16s = (n: number) => Array.from({ length: n }, (_, i) => `2a${(i + 1).toString(16).padStart(2, "0")}::/16`).join("\n") + "\n";

  it("a VPN v6 list covering a large share of 2000::/3 (many /16s) is refused, previous copy kept", async () => {
    failing = new Set();
    const dir = await freshDir();
    await refreshAccessData({ dir, sources: sources(), now: new Date("2026-10-22T00:00:00Z") });
    routes["/vpn6-broad"] = v6Slash16s(40);
    try {
      const broad = sources().map((s) => (s.id === "vpn-ipv6" ? { ...s, url: `${base}/vpn6-broad` } : s));
      const result = await refreshAccessData({ dir, sources: broad, now: new Date("2026-10-29T00:00:00Z") });
      expect(MAX_VPN_V6_SHARE).toBe(0.000005);
      expect(result.sources["vpn-ipv6"]?.ok).toBe(false);
      expect(result.sources["vpn-ipv6"]?.error).toMatch(/of 2000::\/3 \(global IPv6 unicast\), above the 0\.00050% ceiling/);
      const data = await loadAccessDataFromDir(dir);
      expect(data.isVpnIp("2a05:1::1")).toBe(false); // the broad list never landed
      expect(data.isVpnIp("2a0d:5600::1")).toBe(true); // the old copy still answers
    } finally {
      delete routes["/vpn6-broad"];
    }
  });

  it("a VPN v6 list of one residential-size /20 is refused; a /29 like today's is accepted", async () => {
    failing = new Set();
    const dir = await freshDir();
    routes["/vpn6-isp"] = "2601::/20\n";
    routes["/vpn6-small"] = "2a0d:5600::/29\n2a0d:5700::/29\n";
    try {
      const isp = sources().map((s) => (s.id === "vpn-ipv6" ? { ...s, url: `${base}/vpn6-isp` } : s));
      expect((await refreshAccessData({ dir, sources: isp, now: new Date("2026-10-22T00:00:00Z") })).sources["vpn-ipv6"]?.ok).toBe(false);
      const small = sources().map((s) => (s.id === "vpn-ipv6" ? { ...s, url: `${base}/vpn6-small` } : s));
      expect((await refreshAccessData({ dir, sources: small, now: new Date("2026-10-22T00:00:00Z") })).sources["vpn-ipv6"]?.ok).toBe(true);
    } finally {
      delete routes["/vpn6-isp"];
      delete routes["/vpn6-small"];
    }
  });

  it("a datacenter v6 list containing a /16 is refused; today's real-shaped fixture is accepted", async () => {
    failing = new Set();
    const dir = await freshDir();
    routes["/dc6-broad"] = routes["/dc6"] + v6Slash16s(1);
    try {
      const broad = sources().map((s) => (s.id === "datacenter-ipv6" ? { ...s, url: `${base}/dc6-broad` } : s));
      const result = await refreshAccessData({ dir, sources: broad, now: new Date("2026-10-22T00:00:00Z") });
      expect(MAX_DATACENTER_V6_SHARE).toBe(0.00005);
      expect(result.sources["datacenter-ipv6"]?.ok).toBe(false);
      expect(result.sources["datacenter-ipv6"]?.error).toMatch(/above the 0\.0050% ceiling/);
      const plain = await refreshAccessData({ dir, sources: sources(), now: new Date("2026-10-22T00:00:00Z") });
      expect(plain.sources["datacenter-ipv6"]?.ok).toBe(true);
    } finally {
      delete routes["/dc6-broad"];
    }
  });

  it("with no copy on disk and every download failing, nothing loads and nothing throws", async () => {
    failing = new Set(Object.keys(routes));
    const dir = await freshDir();
    const result = await refreshAccessData({ dir, sources: sources() });
    expect(result.ok).toBe(false);
    const data = await loadAccessDataFromDir(dir);
    expect(data.loaded.datacenter).toBe(false);
    expect(data.loaded.vpn).toBe(false);
    expect(accessDataNeedsRefresh(dir, new Date())).toBe(true);
  });

  it("files on disk that parse to zero entries do not count as loaded", async () => {
    const dir = await freshDir();
    for (const f of [ACCESS_FILES.datacenterV4, ACCESS_FILES.datacenterV6, ACCESS_FILES.vpnV4, ACCESS_FILES.vpnV6]) {
      await fsp.writeFile(path.join(dir, f), "<html>Not Found</html>\n");
    }
    await fsp.writeFile(path.join(dir, ACCESS_FILES.apnic), JSON.stringify({ Data: [] }));
    const data = await loadAccessDataFromDir(dir);
    expect(data.loaded.datacenter).toBe(false);
    expect(data.loaded.vpn).toBe(false);
    expect(data.loaded.apnic).toBe(false);
  });

  it("one list of a pair parsing to zero ranges leaves that pair unloaded", async () => {
    const dir = await freshDir();
    await fsp.writeFile(path.join(dir, ACCESS_FILES.datacenterV4), "<html>Not Found</html>\n");
    await fsp.writeFile(path.join(dir, ACCESS_FILES.datacenterV6), fixture("x4bnet-ipv6.txt"));
    const data = await loadAccessDataFromDir(dir);
    expect(data.isDatacenterIp("2001:db8::1")).toBe(true);
    expect(data.loaded.datacenter).toBe(false);
  });

  it("a missing directory is created", async () => {
    failing = new Set();
    const dir = path.join(await freshDir(), "nested", "geoip");
    const result = await refreshAccessData({ dir, sources: sources() });
    expect(result.ok).toBe(true);
  });

  it("an operator-supplied PeeringDB export in the directory is loaded (never downloaded)", async () => {
    failing = new Set();
    const dir = await freshDir();
    await fsp.writeFile(path.join(dir, ACCESS_FILES.peeringdb), fixture("peeringdb-net.json"));
    const data = await loadAccessDataFromDir(dir);
    expect(data.peeringdbType(7922)).toBe("access");
    expect(data.loaded.peeringdb).toBe(true);
    expect(ACCESS_SOURCES.some((s) => s.file === ACCESS_FILES.peeringdb)).toBe(false);
  });
});

describe("startup retry until the VPN/datacenter lists load", () => {
  it("backs off 15 → 30 → 60 minutes and stays at 60", () => {
    expect([0, 1, 2, 3, 10].map((n) => accessRetryDelayMs(n) / 60_000)).toEqual([15, 30, 60, 60, 60]);
  });
  it("retries until an attempt loads the data, then stops", async () => {
    const delays: number[] = [];
    const pending: Array<() => Promise<void> | void> = [];
    const outcomes = [false, false, false, true];
    let attempts = 0;
    scheduleAccessRetry(async () => outcomes[attempts++], (fn, ms) => { delays.push(ms); pending.push(fn); });
    while (pending.length) await pending.shift()!();
    expect(attempts).toBe(4);
    expect(delays.map((ms) => ms / 60_000)).toEqual([15, 30, 60, 60]);
  });
  it("an attempt that throws counts as not loaded and is retried", async () => {
    const delays: number[] = [];
    const pending: Array<() => Promise<void> | void> = [];
    let attempts = 0;
    scheduleAccessRetry(async () => { attempts++; if (attempts === 1) throw new Error("network down"); return true; },
      (fn, ms) => { delays.push(ms); pending.push(fn); });
    while (pending.length) await pending.shift()!();
    expect(attempts).toBe(2);
    expect(delays.length).toBe(2);
  });
});

describe("downloadAccessFile byte cap", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/declared") { res.writeHead(200, { "Content-Length": "5000" }); res.end("x".repeat(5000)); return; }
      if (req.url === "/chunked") {
        // No Content-Length: the cap must hold while streaming.
        res.writeHead(200);
        for (let i = 0; i < 10; i++) res.write("y".repeat(500));
        res.end();
        return;
      }
      res.writeHead(200); res.end("1.2.3.0/24\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("a declared Content-Length above the cap is refused before reading", async () => {
    await expect(downloadAccessFile(`${base}/declared`, { maxBytes: 1000 })).rejects.toThrow(/5000 bytes, above the 1000-byte cap/);
  });
  it("a body without Content-Length is cut off once it passes the cap", async () => {
    await expect(downloadAccessFile(`${base}/chunked`, { maxBytes: 1000 })).rejects.toThrow(/passed the 1000-byte cap/);
  });
  it("a body under the cap is returned whole", async () => {
    expect((await downloadAccessFile(`${base}/small`, { maxBytes: 1000 })).toString()).toBe("1.2.3.0/24\n");
  });
});
