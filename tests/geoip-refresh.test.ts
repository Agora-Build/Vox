import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveGeoipSource,
  buildDownloadUrls,
  refreshGeoipDatabases,
  getGeoipRefreshStatus,
  getMaxmindKey,
  validateMaxmindKeyInput,
  sanitizeErrorMessage,
  downloadDefault,
  DOWNLOAD_TIMEOUT_MS,
  type RefreshDeps,
} from "../server/geoip-refresh";
import { isEncryptionConfigured } from "../server/storage";

describe("resolveGeoipSource", () => {
  it("picks geolite2 when a key is present", () => {
    expect(resolveGeoipSource("abc123")).toBe("geolite2");
  });
  it("falls back to dbip when the key is null/undefined", () => {
    expect(resolveGeoipSource(null)).toBe("dbip");
    expect(resolveGeoipSource(undefined)).toBe("dbip");
  });
  it("falls back to dbip when the key is an empty string", () => {
    expect(resolveGeoipSource("")).toBe("dbip");
  });
});

describe("buildDownloadUrls", () => {
  it("geolite2: returns edition URLs with no license_key embedded", () => {
    const urls = buildDownloadUrls("geolite2", new Date("2026-09-02T00:00:00Z"));
    expect(urls.city).toContain("edition_id=GeoLite2-City");
    expect(urls.asn).toContain("edition_id=GeoLite2-ASN");
    expect(urls.city).not.toContain("license_key");
    expect(urls.asn).not.toContain("license_key");
    expect(urls.cityFallback).toBeUndefined();
    expect(urls.asnFallback).toBeUndefined();
  });

  it("dbip: builds current-UTC-month URLs plus a previous-month fallback", () => {
    const urls = buildDownloadUrls("dbip", new Date("2026-09-02T00:00:00Z"));
    expect(urls.city).toBe("https://download.db-ip.com/free/dbip-city-lite-2026-09.mmdb.gz");
    expect(urls.cityFallback).toBe("https://download.db-ip.com/free/dbip-city-lite-2026-08.mmdb.gz");
    expect(urls.asn).toBe("https://download.db-ip.com/free/dbip-asn-lite-2026-09.mmdb.gz");
    expect(urls.asnFallback).toBe("https://download.db-ip.com/free/dbip-asn-lite-2026-08.mmdb.gz");
  });

  it("dbip: rolls the previous month across a year boundary", () => {
    const urls = buildDownloadUrls("dbip", new Date("2026-01-15T00:00:00Z"));
    expect(urls.city).toBe("https://download.db-ip.com/free/dbip-city-lite-2026-01.mmdb.gz");
    expect(urls.cityFallback).toBe("https://download.db-ip.com/free/dbip-city-lite-2025-12.mmdb.gz");
  });
});

describe("getMaxmindKey resolution order", () => {
  it("console-managed key beats the env var", async () => {
    // isEncryptionConfigured() gates whether we can even test the console
    // path end-to-end (it needs CREDENTIAL_ENCRYPTION_KEY); when it's not
    // configured in this environment we only assert the env fallback below.
    if (!isEncryptionConfigured()) return;
    const { storage, encryptValue } = await import("../server/storage");
    const original = process.env.MAXMIND_LICENSE_KEY;
    process.env.MAXMIND_LICENSE_KEY = "env-key";
    try {
      await storage.setConfig({ key: "maxmind_license_key", value: encryptValue("console-key") });
      const result = await getMaxmindKey();
      expect(result).toEqual({ key: "console-key", source: "console" });
    } finally {
      await storage.deleteConfig("maxmind_license_key");
      if (original === undefined) delete process.env.MAXMIND_LICENSE_KEY;
      else process.env.MAXMIND_LICENSE_KEY = original;
    }
  });

  it("falls back to the env var when no console key is stored", async () => {
    const { storage } = await import("../server/storage");
    await storage.deleteConfig("maxmind_license_key"); // ensure clean slate
    const original = process.env.MAXMIND_LICENSE_KEY;
    process.env.MAXMIND_LICENSE_KEY = "env-key";
    try {
      const result = await getMaxmindKey();
      expect(result).toEqual({ key: "env-key", source: "env" });
    } finally {
      if (original === undefined) delete process.env.MAXMIND_LICENSE_KEY;
      else process.env.MAXMIND_LICENSE_KEY = original;
    }
  });

  it("returns null/null when neither is set", async () => {
    const { storage } = await import("../server/storage");
    await storage.deleteConfig("maxmind_license_key");
    const original = process.env.MAXMIND_LICENSE_KEY;
    delete process.env.MAXMIND_LICENSE_KEY;
    try {
      const result = await getMaxmindKey();
      expect(result).toEqual({ key: null, source: null });
    } finally {
      if (original !== undefined) process.env.MAXMIND_LICENSE_KEY = original;
    }
  });
});

describe("validateMaxmindKeyInput", () => {
  it("rejects an empty/whitespace-only key regardless of encryption config", () => {
    expect(validateMaxmindKeyInput("")).toEqual({ ok: false, error: "key is required" });
    expect(validateMaxmindKeyInput("   ")).toEqual({ ok: false, error: "key is required" });
    expect(validateMaxmindKeyInput(undefined)).toEqual({ ok: false, error: "key is required" });
    expect(validateMaxmindKeyInput(42)).toEqual({ ok: false, error: "key is required" });
  });

  it("rejects a non-empty key when CREDENTIAL_ENCRYPTION_KEY is not configured", () => {
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    try {
      const result = validateMaxmindKeyInput("  some-key  ");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("CREDENTIAL_ENCRYPTION_KEY");
    } finally {
      if (original === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = original;
    }
  });

  it("accepts and trims a non-empty key when encryption is configured", () => {
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64); // valid 32-byte hex
    try {
      expect(validateMaxmindKeyInput("  some-key  ")).toEqual({ ok: true, key: "some-key" });
    } finally {
      if (original === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = original;
    }
  });
});

describe("sanitizeErrorMessage", () => {
  it("redacts a license_key embedded in a real-shaped MaxMind fetch error", () => {
    const msg =
      "request to https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=SECRETVALUE123&suffix=tar.gz failed";
    const out = sanitizeErrorMessage(msg);
    expect(out).not.toContain("SECRETVALUE123");
    expect(out).toContain("license_key=REDACTED");
  });

  it("redacts case-insensitively and regardless of what follows (& or end of string)", () => {
    expect(sanitizeErrorMessage("LICENSE_KEY=abc123&suffix=tar.gz")).toBe("license_key=REDACTED&suffix=tar.gz");
    expect(sanitizeErrorMessage("...license_key=abc123")).toBe("...license_key=REDACTED");
  });

  it("leaves key-free messages untouched", () => {
    expect(sanitizeErrorMessage("network down")).toBe("network down");
  });
});

describe("downloadDefault (network timeout bound)", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("passes an AbortSignal to fetch so a hung request cannot wedge state forever", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(Buffer.from("ok"), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const buf = await downloadDefault("https://example.com/x");
    expect(buf.toString()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("DOWNLOAD_TIMEOUT_MS is at least 120s (files run 50-90MB)", () => {
    expect(DOWNLOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("a timed-out fetch flows through refreshGeoipDatabases's normal failure handling: state returns to idle and the error is recorded (sanitized)", async () => {
    global.fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;

    // Deliberately don't override `download` — this exercises the real
    // downloadDefault (and therefore the real AbortSignal.timeout wiring)
    // through the full refresh pipeline, not a mock.
    const result = await refreshGeoipDatabases({
      getMaxmindKey: vi.fn(async () => ({ key: null, source: null as const })),
      now: new Date("2026-09-02T00:00:00Z"),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted");
    expect(result.error).not.toContain("license_key");
    expect(getGeoipRefreshStatus().state).toBe("idle");
  });
});

describe("refreshGeoipDatabases", () => {
  function makeDeps(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
    return {
      dir: "/fake/geoip",
      now: new Date("2026-09-02T00:00:00Z"),
      getMaxmindKey: vi.fn(async () => ({ key: null, source: null as const })), // dbip path by default
      download: vi.fn(async () => Buffer.from("raw-bytes")),
      gunzip: vi.fn(async (data: Buffer) => Buffer.concat([Buffer.from("decompressed:"), data])),
      extractTarGz: vi.fn(async () => Buffer.from("extracted-mmdb-bytes")),
      writeFile: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
      validateMmdb: vi.fn(async () => true),
      reload: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it("success path: downloads+decompresses both DBs, writes meta, renames into place, and reloads", async () => {
    const deps = makeDeps();
    const result = await refreshGeoipDatabases(deps);

    expect(result.ok).toBe(true);
    expect(result.source).toBe("dbip");
    expect(deps.download).toHaveBeenCalledTimes(2); // city + asn
    expect(deps.gunzip).toHaveBeenCalledTimes(2);
    expect(deps.extractTarGz).not.toHaveBeenCalled();
    expect(deps.rename).toHaveBeenCalledTimes(2); // City.mmdb, ASN.mmdb
    expect(deps.rename).toHaveBeenCalledWith(expect.any(String), "/fake/geoip/City.mmdb");
    expect(deps.rename).toHaveBeenCalledWith(expect.any(String), "/fake/geoip/ASN.mmdb");
    expect(deps.writeFile).toHaveBeenCalledTimes(3); // City tmp, ASN tmp, geoip-meta.json
    expect(deps.reload).toHaveBeenCalledTimes(1);

    const metaCall = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      ([target]) => target === "/fake/geoip/geoip-meta.json",
    );
    expect(metaCall).toBeTruthy();
    const meta = JSON.parse(metaCall![1].toString());
    expect(meta.source).toBe("dbip");
    expect(meta.fetchedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(meta.files.City).toBeTruthy();
    expect(meta.files.ASN).toBeTruthy();

    const status = getGeoipRefreshStatus();
    expect(status.state).toBe("idle");
    expect(status.lastResult?.ok).toBe(true);
    expect(status.lastResult?.source).toBe("dbip");
  });

  it("uses extractTarGz (not gunzip) for the geolite2 source and never leaks the license key", async () => {
    const deps = makeDeps({ getMaxmindKey: vi.fn(async () => ({ key: "super-secret-key", source: "env" as const })) });
    const result = await refreshGeoipDatabases(deps);

    expect(result.ok).toBe(true);
    expect(result.source).toBe("geolite2");
    expect(deps.extractTarGz).toHaveBeenCalledTimes(2);
    expect(deps.gunzip).not.toHaveBeenCalled();

    // The recorded result/status must never contain the raw key value, even
    // though it was necessarily composed into the (mocked) download URL.
    expect(JSON.stringify(result)).not.toContain("super-secret-key");
    const status = getGeoipRefreshStatus();
    expect(JSON.stringify(status)).not.toContain("super-secret-key");
  });

  it("dbip: falls back to the previous month on a 404 for the current month", async () => {
    const urls = buildDownloadUrls("dbip", new Date("2026-09-02T00:00:00Z"));
    const download = vi.fn(async (url: string) => {
      if (url === urls.city) {
        const err = new Error("HTTP 404") as Error & { status?: number };
        err.status = 404;
        throw err;
      }
      return Buffer.from("raw-bytes");
    });
    const deps = makeDeps({ download });
    const result = await refreshGeoipDatabases(deps);

    expect(result.ok).toBe(true);
    expect(download).toHaveBeenCalledWith(urls.cityFallback);
    expect(download).toHaveBeenCalledWith(urls.asn);
  });

  it("validation failure: keeps old files (no rename of the canonical name) and records the error", async () => {
    const rename = vi.fn(async () => {});
    const deps = makeDeps({ validateMmdb: vi.fn(async () => false), rename });
    const result = await refreshGeoipDatabases(deps);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(rename).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();

    const status = getGeoipRefreshStatus();
    expect(status.state).toBe("idle");
    expect(status.lastResult?.ok).toBe(false);
    expect(status.lastResult?.error).toBeTruthy();
  });

  it("download failure: records the error without throwing and without calling reload", async () => {
    const deps = makeDeps({
      download: vi.fn(async () => { throw new Error("network down"); }),
    });
    const result = await refreshGeoipDatabases(deps);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("a key-bearing download error is redacted in both lastResult.error and the logged line — GET /api/admin/geoip/status echoes lastResult.error verbatim, and the request-logging middleware writes that response to the server log, so this is the sole guard against a leak", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const keyBearingMessage =
        "request to https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=SECRETVALUE123&suffix=tar.gz failed";
      const deps = makeDeps({
        getMaxmindKey: vi.fn(async () => ({ key: "SECRETVALUE123", source: "env" as const })),
        download: vi.fn(async () => { throw new Error(keyBearingMessage); }),
      });
      const result = await refreshGeoipDatabases(deps);

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).not.toContain("SECRETVALUE123");
      expect(result.error).toContain("license_key=REDACTED");

      // What GET /api/admin/geoip/status would actually serialize and what the
      // request-logging middleware would write to the log — assert on the
      // same JSON.stringify a real response body goes through.
      expect(JSON.stringify(getGeoipRefreshStatus())).not.toContain("SECRETVALUE123");

      // The one console.error line the module emits per failed refresh.
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const loggedLine = consoleErrorSpy.mock.calls[0][0] as string;
      expect(loggedLine).not.toContain("SECRETVALUE123");
      expect(loggedLine).toContain("license_key=REDACTED");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("a failing geolite2 download after a healthy dbip state leaves existing files/readers untouched", async () => {
    // Simulates: DB-IP files already on disk and serving, operator saves a bad
    // MaxMind key, refresh is triggered, the GeoLite2 download fails. The
    // atomic rename-only-after-validation design means this can never disturb
    // the files already in place — assert the failure path never renames.
    const rename = vi.fn(async () => {});
    const deps = makeDeps({
      getMaxmindKey: vi.fn(async () => ({ key: "bad-key", source: "env" as const })),
      download: vi.fn(async () => { throw new Error("HTTP 401 Unauthorized"); }),
      rename,
    });
    const result = await refreshGeoipDatabases(deps);

    expect(result.ok).toBe(false);
    expect(result.source).toBe("geolite2");
    expect(rename).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });
});
