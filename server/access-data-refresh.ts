/**
 * In-app refresher for the network access data (server/access-data.ts).
 *
 * Same pattern as server/geoip-refresh.ts: downloads into GEOIP_DB_DIR, each
 * file validated (it must parse to at least `minEntries` entries — an HTML
 * error page or a truncated download parses to nearly nothing) before an
 * atomic rename replaces the previous copy. Sources refresh independently: one
 * failing keeps its previous file and never blocks the others. Driven from
 * server startup (when a file is missing or older than 7 days) and a weekly
 * timer, both owned by server/location.ts.
 *
 * PeeringDB is deliberately absent: its AUP forbids storing the data for a
 * commercial application without PeeringDB's approval (see access-data.ts).
 */
import path from "path";
import { promises as fsp, readFileSync, existsSync } from "fs";
import { GEOIP_DIR, DOWNLOAD_TIMEOUT_MS } from "./geoip-refresh";
import { ACCESS_FILES, parseCidrList, parseIpcatCsv, parseApnicAspop } from "./access-data";

export const ACCESS_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCESS_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export type AccessSourceId = "datacenter-ipv4" | "datacenter-ipv6" | "vpn-ipv4" | "vpn-ipv6" | "ipcat" | "apnic";

export interface AccessSource {
  id: AccessSourceId;
  url: string;
  file: string;
  /** Entries the download must parse to before it may replace the previous copy. */
  minEntries: number;
  /** Counts valid entries; throws on a document that isn't the expected format. */
  count: (text: string) => number;
}

const X4B = "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output";
const cidrCount = (t: string) => { const p = parseCidrList(t); return p.v4.length + p.v6.length; };

// Floors sit well under today's sizes (2026-10-22: datacenter v4 44.6k CIDRs,
// v6 8.8k, vpn v4 10.9k, vpn v6 498, ipcat 3.4k rows, APNIC 46k rows / 39.7k ASNs).
export const ACCESS_SOURCES: readonly AccessSource[] = [
  { id: "datacenter-ipv4", url: `${X4B}/datacenter/ipv4.txt`, file: ACCESS_FILES.datacenterV4, minEntries: 5000, count: cidrCount },
  { id: "datacenter-ipv6", url: `${X4B}/datacenter/ipv6.txt`, file: ACCESS_FILES.datacenterV6, minEntries: 500, count: cidrCount },
  { id: "vpn-ipv4", url: `${X4B}/vpn/ipv4.txt`, file: ACCESS_FILES.vpnV4, minEntries: 1000, count: cidrCount },
  { id: "vpn-ipv6", url: `${X4B}/vpn/ipv6.txt`, file: ACCESS_FILES.vpnV6, minEntries: 20, count: cidrCount },
  {
    id: "ipcat",
    url: "https://raw.githubusercontent.com/client9/ipcat/master/datacenters.csv",
    file: ACCESS_FILES.ipcat,
    minEntries: 1000,
    count: (t) => parseIpcatCsv(t).v4.length,
  },
  {
    id: "apnic",
    url: "https://stats.labs.apnic.net/cgi-bin/aspop?f=j",
    file: ACCESS_FILES.apnic,
    minEntries: 1000,
    count: (t) => parseApnicAspop(JSON.parse(t)).size,
  },
];

export interface AccessRefreshDeps {
  dir: string;
  now: Date;
  sources: readonly AccessSource[];
  download: (url: string) => Promise<Buffer>;
}

export interface AccessSourceResult {
  ok: boolean;
  entries?: number;
  error?: string;
}

export interface AccessRefreshResult {
  ok: boolean;
  at: string;
  sources: Partial<Record<AccessSourceId, AccessSourceResult>>;
}

interface AccessMeta {
  sources: Partial<Record<AccessSourceId, { fetchedAt: string; entries: number }>>;
}

function readMeta(dir: string): AccessMeta {
  try {
    const meta = JSON.parse(readFileSync(path.join(dir, ACCESS_FILES.meta), "utf8")) as AccessMeta;
    return meta && typeof meta.sources === "object" && meta.sources ? meta : { sources: {} };
  } catch {
    return { sources: {} };
  }
}

/** True when any source's file is missing or was last fetched more than 7 days ago. */
export function accessDataNeedsRefresh(dir: string = GEOIP_DIR, now: Date = new Date(), sources: readonly AccessSource[] = ACCESS_SOURCES): boolean {
  const meta = readMeta(dir);
  return sources.some((s) => {
    if (!existsSync(path.join(dir, s.file))) return true;
    const fetchedAt = new Date(meta.sources[s.id]?.fetchedAt ?? NaN).getTime();
    return !(Number.isFinite(fetchedAt) && now.getTime() - fetchedAt < ACCESS_STALE_MS);
  });
}

/** Same timeout as the GeoIP downloads; names the software, as PeeringDB/APNIC-style hosts ask. */
export async function downloadAccessFile(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { "User-Agent": "Vox access-data refresh (https://github.com/Agora-Build/Vox)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${new URL(url).host}`);
  return Buffer.from(await res.arrayBuffer());
}

let inFlight: Promise<AccessRefreshResult> | null = null;

/**
 * Downloads every source. Never throws; per-source failures are reported and
 * leave that source's previous file untouched. A refresh already running is
 * joined rather than started twice.
 */
export function refreshAccessData(overrides: Partial<AccessRefreshDeps> = {}): Promise<AccessRefreshResult> {
  if (inFlight && Object.keys(overrides).length === 0) return inFlight;
  const run = doRefresh({ dir: GEOIP_DIR, now: new Date(), sources: ACCESS_SOURCES, download: downloadAccessFile, ...overrides })
    .finally(() => { if (inFlight === run) inFlight = null; });
  if (Object.keys(overrides).length === 0) inFlight = run;
  return run;
}

async function doRefresh(deps: AccessRefreshDeps): Promise<AccessRefreshResult> {
  const at = deps.now.toISOString();
  const results: AccessRefreshResult["sources"] = {};
  try {
    await fsp.mkdir(deps.dir, { recursive: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[access-data] cannot create ${deps.dir}: ${error}`);
    for (const s of deps.sources) results[s.id] = { ok: false, error };
    return { ok: false, at, sources: results };
  }
  const meta = readMeta(deps.dir);

  for (const source of deps.sources) {
    const tmpPath = path.join(deps.dir, `.tmp-${source.id}-${deps.now.getTime()}`);
    try {
      const body = await deps.download(source.url);
      const text = body.toString("utf8");
      let entries: number;
      try {
        entries = source.count(text);
      } catch (err) {
        throw new Error(`download did not parse (${err instanceof Error ? err.message : String(err)})`);
      }
      if (entries < source.minEntries) {
        throw new Error(`download has ${entries} entries, below the ${source.minEntries} minimum`);
      }
      await fsp.writeFile(tmpPath, body);
      await fsp.rename(tmpPath, path.join(deps.dir, source.file));
      meta.sources[source.id] = { fetchedAt: at, entries };
      results[source.id] = { ok: true, entries };
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[access-data] ${source.id} refresh failed, keeping previous copy: ${error}`);
      results[source.id] = { ok: false, error };
    }
  }

  try {
    const metaTmp = path.join(deps.dir, `.tmp-meta-${deps.now.getTime()}`);
    await fsp.writeFile(metaTmp, JSON.stringify(meta, null, 2));
    await fsp.rename(metaTmp, path.join(deps.dir, ACCESS_FILES.meta));
  } catch (err) {
    console.error(`[access-data] could not write ${ACCESS_FILES.meta}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: deps.sources.every((s) => results[s.id]?.ok), at, sources: results };
}
