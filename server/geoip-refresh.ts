/**
 * In-app GeoIP database refresher.
 *
 * Coolify containers have ephemeral filesystems, so the old cron script
 * (scripts/geoip-refresh.sh) could not keep GEOIP_DB_DIR populated across
 * redeploys. This module downloads the same two databases the script used
 * to fetch — MaxMind GeoLite2 (City + ASN) when a license key is available,
 * DB-IP Lite (CC-BY-4.0, no key needed) otherwise — and is driven from three
 * places: server startup (server/location.ts), a weekly timer (also owned by
 * location.ts), and an admin "Refresh" button (server/routes.ts).
 *
 * Import direction: this module never imports server/location.ts. Its
 * `reload` step (re-opening the mmdb readers after a successful download) is
 * an INJECTED dependency — callers that need it (location.ts's startup/timer
 * hook, and the admin refresh route) pass `reloadGeoReaders` in explicitly.
 * That keeps the dependency graph one-directional (location.ts -> this file)
 * instead of a cycle.
 *
 * The MaxMind license key can live in two places, resolved in this order by
 * getMaxmindKey(): an admin-console-managed value in `systemConfig`
 * (encrypted with the same AES-256-GCM primitives the secrets feature uses),
 * then the MAXMIND_LICENSE_KEY env var as a bootstrap fallback. The key is
 * never returned from getMaxmindKey() to a caller that might log or persist
 * it in the clear beyond systemConfig, and it is composed onto a download URL
 * only in memory, immediately before the request — buildDownloadUrls() never
 * embeds it in a string that could end up in a log line or a thrown error.
 */
import path from "path";
import { promises as fsp } from "fs";
import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { gunzip as gunzipCb } from "zlib";
import { promisify } from "util";
import { open as maxmindOpen } from "maxmind";
import { storage, encryptValue, decryptValue, isEncryptionConfigured } from "./storage";

const gunzipAsync = promisify(gunzipCb);

// Duplicated (not imported) from server/location.ts on purpose — see the
// import-direction note above. It is a one-line env lookup, not worth a cycle.
export const GEOIP_DIR = process.env.GEOIP_DB_DIR || path.join(process.cwd(), "geoip");

export const MAXMIND_KEY_CONFIG_KEY = "maxmind_license_key";

// City/ASN files run 50-90MB; 120s is the floor for a healthy connection to
// finish, not a target. Without this, a hung fetch would leave module `state`
// stuck at "refreshing" forever — every future POST /refresh would 409 until
// the process restarts.
export const DOWNLOAD_TIMEOUT_MS = 120_000;

// CC BY 4.0 requires visible credit when DB-IP data ships in the product.
export const DBIP_ATTRIBUTION = "IP Geolocation by DB-IP (db-ip.com), CC BY 4.0";

export type GeoipSource = "geolite2" | "dbip";
export type MaxmindKeySource = "console" | "env" | null;

/**
 * Resolves which key wins when both a console-managed value and the env var
 * are present: console beats env. Used by getMaxmindKey() and by the
 * admin status route so both report the same answer.
 */
export async function getMaxmindKey(): Promise<{ key: string | null; source: MaxmindKeySource }> {
  try {
    const row = await storage.getConfig(MAXMIND_KEY_CONFIG_KEY);
    if (row?.value) {
      return { key: decryptValue(row.value), source: "console" };
    }
  } catch (err) {
    // Decryption can fail if CREDENTIAL_ENCRYPTION_KEY rotated out from under
    // a stored value — degrade to the env fallback rather than crash a
    // refresh over it.
    console.error(
      `[geoip] console-managed MaxMind key could not be decrypted, falling back to env (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (process.env.MAXMIND_LICENSE_KEY) {
    return { key: process.env.MAXMIND_LICENSE_KEY, source: "env" };
  }
  return { key: null, source: null };
}

/** Pure: the source is entirely determined by whether a key is present. */
export function resolveGeoipSource(maxmindKey: string | null | undefined): GeoipSource {
  return maxmindKey ? "geolite2" : "dbip";
}

export interface DownloadUrls {
  city: string;
  asn: string;
  // Only set for dbip — the current month's file can 404 before publication.
  cityFallback?: string;
  asnFallback?: string;
}

function yyyymm(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function previousMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}

/**
 * Pure and deterministic given `now` — never touches the network or embeds
 * the MaxMind license key (that is composed separately, at fetch time, by
 * refreshGeoipDatabases()).
 */
export function buildDownloadUrls(source: GeoipSource, now: Date = new Date()): DownloadUrls {
  if (source === "geolite2") {
    return {
      city: "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&suffix=tar.gz",
      asn: "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-ASN&suffix=tar.gz",
    };
  }
  const month = yyyymm(now);
  const prev = yyyymm(previousMonth(now));
  return {
    city: `https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz`,
    cityFallback: `https://download.db-ip.com/free/dbip-city-lite-${prev}.mmdb.gz`,
    asn: `https://download.db-ip.com/free/dbip-asn-lite-${month}.mmdb.gz`,
    asnFallback: `https://download.db-ip.com/free/dbip-asn-lite-${prev}.mmdb.gz`,
  };
}

function withLicenseKey(url: string, key: string): string {
  return `${url}&license_key=${encodeURIComponent(key)}`;
}

/**
 * Defense in depth: strip a license_key value out of any message we log or
 * persist. This is the SOLE guard against a key landing in error text that
 * flows into `lastResult.error` — which GET /api/admin/geoip/status echoes
 * verbatim, and whose response the request-logging middleware writes to the
 * server log. Exported so tests can exercise it directly with a key-bearing
 * message shaped like the real MaxMind fetch error (see
 * tests/geoip-refresh.test.ts).
 */
export function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/license_key=[^&\s]+/gi, "license_key=REDACTED");
}

export interface RefreshDeps {
  dir: string;
  now: Date;
  getMaxmindKey: () => Promise<{ key: string | null; source: MaxmindKeySource }>;
  mkdir: (dir: string) => Promise<void>;
  download: (url: string) => Promise<Buffer>;
  gunzip: (data: Buffer) => Promise<Buffer>;
  extractTarGz: (data: Buffer, editionId: string) => Promise<Buffer>;
  writeFile: (path: string, data: Buffer | string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  validateMmdb: (path: string) => Promise<boolean>;
  reload: () => Promise<void>;
}

export interface RefreshResult {
  ok: boolean;
  source: GeoipSource;
  at: string;
  error?: string;
}

interface DbTarget {
  name: "City" | "ASN";
  editionId: "GeoLite2-City" | "GeoLite2-ASN";
}
const TARGETS: DbTarget[] = [
  { name: "City", editionId: "GeoLite2-City" },
  { name: "ASN", editionId: "GeoLite2-ASN" },
];

// Exported for tests only — lets tests prove the AbortSignal timeout wiring
// and its failure path without waiting out a real 120s timeout.
export async function downloadDefault(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} downloading GeoIP database`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

async function gunzipDefault(data: Buffer): Promise<Buffer> {
  return gunzipAsync(data);
}

/**
 * MaxMind ships each edition as a tar.gz containing a single dated directory
 * (e.g. GeoLite2-City_20260101/GeoLite2-City.mmdb). Shells out to the system
 * `tar` rather than pulling in a tar-parsing dependency for one call site.
 */
async function extractTarGzDefault(data: Buffer, editionId: string): Promise<Buffer> {
  const workDir = await mkdtemp(path.join(tmpdir(), "geoip-extract-"));
  try {
    const archivePath = path.join(workDir, "archive.tar.gz");
    await fsp.writeFile(archivePath, data);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("tar", ["-xzf", archivePath, "-C", workDir]);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.slice(0, 200)}`))));
    });
    const entries = await fsp.readdir(workDir, { withFileTypes: true });
    const extractedDir = entries.find((e) => e.isDirectory() && e.name.startsWith(editionId));
    if (!extractedDir) throw new Error(`extracted archive missing a ${editionId}_* directory`);
    return await fsp.readFile(path.join(workDir, extractedDir.name, `${editionId}.mmdb`));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function validateMmdbDefault(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size <= 1024 * 1024) return false; // > 1MB — catches truncated/HTML-error downloads
    await maxmindOpen(filePath); // throws if the file isn't a well-formed mmdb
    return true;
  } catch {
    return false;
  }
}

function defaultDeps(): RefreshDeps {
  return {
    dir: GEOIP_DIR,
    now: new Date(),
    getMaxmindKey,
    // recursive:true is a no-op (not an error) when the dir already exists —
    // no separate existence check needed. Fresh containers (Coolify's
    // ephemeral filesystem) have no GEOIP_DB_DIR yet, and the very first
    // refresh used to ENOENT trying to write its .tmp-*.mmdb file there.
    mkdir: (dir) => fsp.mkdir(dir, { recursive: true }).then(() => {}),
    download: downloadDefault,
    gunzip: gunzipDefault,
    extractTarGz: extractTarGzDefault,
    writeFile: (p, data) => fsp.writeFile(p, data),
    rename: (from, to) => fsp.rename(from, to),
    unlink: (p) => fsp.unlink(p).then(() => {}, () => {}),
    validateMmdb: validateMmdbDefault,
    // No-op by default — see the import-direction note at the top of this
    // file. Real callers (server/location.ts's startup/timer hook and the
    // admin refresh route in server/routes.ts) inject reloadGeoReaders.
    reload: async () => {},
  };
}

let state: "idle" | "refreshing" = "idle";
let lastResult: RefreshResult | null = null;

export function getGeoipRefreshStatus(): { state: "idle" | "refreshing"; lastResult: RefreshResult | null } {
  return { state, lastResult };
}

/**
 * Downloads City + ASN into GEOIP_DIR, validating each before it replaces the
 * canonical file. On ANY failure — network, extraction, or validation — the
 * existing files and readers are left exactly as they were: the loop aborts
 * before the rename that would swap in a new file, so a bad download never
 * costs the site its previously-working GeoIP data.
 */
export async function refreshGeoipDatabases(overrides: Partial<RefreshDeps> = {}): Promise<RefreshResult> {
  const deps: RefreshDeps = { ...defaultDeps(), ...overrides };
  state = "refreshing";
  const at = deps.now.toISOString();
  let source: GeoipSource = "dbip";
  try {
    await deps.mkdir(deps.dir);
    const { key: maxmindKey } = await deps.getMaxmindKey();
    source = resolveGeoipSource(maxmindKey);
    const urls = buildDownloadUrls(source, deps.now);
    const files: Record<string, { bytes: number }> = {};

    for (const target of TARGETS) {
      const primary = target.name === "City" ? urls.city : urls.asn;
      const fallback = target.name === "City" ? urls.cityFallback : urls.asnFallback;
      const requestUrl = source === "geolite2" && maxmindKey ? withLicenseKey(primary, maxmindKey) : primary;

      let raw: Buffer;
      try {
        raw = await deps.download(requestUrl);
      } catch (err) {
        const status = (err as { status?: number } | undefined)?.status;
        if (source === "dbip" && fallback && status === 404) {
          raw = await deps.download(fallback);
        } else {
          throw err;
        }
      }

      const mmdbBytes = source === "geolite2"
        ? await deps.extractTarGz(raw, target.editionId)
        : await deps.gunzip(raw);

      const tmpPath = path.join(deps.dir, `.tmp-${target.name}-${deps.now.getTime()}.mmdb`);
      await deps.writeFile(tmpPath, mmdbBytes);
      const valid = await deps.validateMmdb(tmpPath);
      if (!valid) {
        await deps.unlink(tmpPath);
        throw new Error(`${target.name}.mmdb failed validation (size or format) after download`);
      }
      await deps.rename(tmpPath, path.join(deps.dir, `${target.name}.mmdb`));
      files[target.name] = { bytes: mmdbBytes.length };
    }

    const meta = { source, fetchedAt: at, files };
    await deps.writeFile(path.join(deps.dir, "geoip-meta.json"), JSON.stringify(meta, null, 2));
    await deps.reload();

    const result: RefreshResult = { ok: true, source, at };
    lastResult = result;
    state = "idle";
    return result;
  } catch (err) {
    const error = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    console.error(`[geoip] refresh failed (source=${source}): ${error}`);
    const result: RefreshResult = { ok: false, source, at, error };
    lastResult = result;
    state = "idle";
    return result;
  }
}

/**
 * Pure validation for the PUT .../maxmind-key body — trims, requires a
 * non-empty value, and requires CREDENTIAL_ENCRYPTION_KEY to be set (the
 * console-managed key is stored encrypted, same as the secrets feature; with
 * no encryption key configured there is nowhere safe to put it). Kept
 * separate from the route handler so this rejection logic is unit-testable
 * without spinning up Express.
 */
export function validateMaxmindKeyInput(key: unknown): { ok: true; key: string } | { ok: false; error: string } {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) return { ok: false, error: "key is required" };
  if (!isEncryptionConfigured()) {
    return {
      ok: false,
      error: "Set CREDENTIAL_ENCRYPTION_KEY on the server to store a MaxMind license key from the admin console.",
    };
  }
  return { ok: true, key: trimmed };
}

/** Save-path helper for the admin route: encrypts and persists the console-managed key. */
export async function saveMaxmindKey(key: string): Promise<void> {
  await storage.setConfig({ key: MAXMIND_KEY_CONFIG_KEY, value: encryptValue(key) });
}

export async function clearMaxmindKey(): Promise<void> {
  await storage.deleteConfig(MAXMIND_KEY_CONFIG_KEY);
}
