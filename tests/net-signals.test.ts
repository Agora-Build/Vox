/**
 * Agent network signals (vox_eval_agentd/net-signals.ts) — the agent's side
 * of "Last mile vs datacenter (access)" in
 * designs/2026-10-22-network-tags-design.md (Part-2 Task 3).
 *
 * Injectable (fetch/env/platform/sysRoot/exec/clock), so these tests never
 * touch the real network, the real filesystem (beyond a fake /sys tree in a
 * temp dir), or a real wall clock — same style as tests/link-type.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  probeCloudMetadata,
  CloudMetadataCache,
  CLOUD_METADATA_CACHE_MS,
  detectPublicIpOnInterface,
  withNetSignals,
  type FetchLike,
  type PublicIpDeps,
} from "../vox_eval_agentd/net-signals";

// ---------------------------------------------------------------------------
// Cloud metadata
// ---------------------------------------------------------------------------

/** A fake fetch keyed by URL: "ok" → status 200, "unauthorized" → status 401
 *  (still an answer — AWS IMDSv1 without a token), "timeout"/absent → throws
 *  (simulating a real timeout/connection failure without any real wait). */
function fakeFetch(outcomes: Record<string, "ok" | "unauthorized" | "timeout">): FetchLike {
  return async (url) => {
    const outcome = outcomes[url] ?? "timeout";
    if (outcome === "ok") return { status: 200 };
    if (outcome === "unauthorized") return { status: 401 };
    throw new Error("timed out");
  };
}

const AWS_URL = "http://169.254.169.254/latest/meta-data/";
const AZURE_URL = "http://169.254.169.254/metadata/instance?api-version=2021-02-01";
const GCP_URL = "http://metadata.google.internal/computeMetadata/v1/";

describe("probeCloudMetadata", () => {
  it("AWS answers 200 → true", async () => {
    const result = await probeCloudMetadata({ fetch: fakeFetch({ [AWS_URL]: "ok" }), now: () => 0 });
    expect(result).toBe(true);
  });

  it("AWS answers 401 (IMDSv1 without a token) → still true: a metadata service answered", async () => {
    const result = await probeCloudMetadata({ fetch: fakeFetch({ [AWS_URL]: "unauthorized" }), now: () => 0 });
    expect(result).toBe(true);
  });

  it("Azure answers → true", async () => {
    const result = await probeCloudMetadata({ fetch: fakeFetch({ [AZURE_URL]: "ok" }), now: () => 0 });
    expect(result).toBe(true);
  });

  it("GCP answers → true", async () => {
    const result = await probeCloudMetadata({ fetch: fakeFetch({ [GCP_URL]: "ok" }), now: () => 0 });
    expect(result).toBe(true);
  });

  it("all three fail/time out → false", async () => {
    const result = await probeCloudMetadata({ fetch: fakeFetch({}), now: () => 0 });
    expect(result).toBe(false);
  });
});

describe("CloudMetadataCache", () => {
  it("caches a positive result for 10 minutes — the second call within the window never calls fetch again", async () => {
    let calls = 0;
    const fetch: FetchLike = async (url) => {
      calls++;
      return url === AWS_URL ? { status: 200 } : (() => { throw new Error("timeout"); })();
    };
    let now = 0;
    const cache = new CloudMetadataCache();

    expect(await cache.get({ fetch, now: () => now })).toBe(true);
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    now += CLOUD_METADATA_CACHE_MS - 1;
    expect(await cache.get({ fetch, now: () => now })).toBe(true);
    expect(calls).toBe(callsAfterFirst); // no new probes — served from cache
  });

  it("re-probes once the 10-minute cache expires", async () => {
    let calls = 0;
    const fetch: FetchLike = async (url) => {
      calls++;
      return url === AWS_URL ? { status: 200 } : (() => { throw new Error("timeout"); })();
    };
    let now = 0;
    const cache = new CloudMetadataCache();

    await cache.get({ fetch, now: () => now });
    const callsAfterFirst = calls;

    now += CLOUD_METADATA_CACHE_MS + 1;
    await cache.get({ fetch, now: () => now });
    expect(calls).toBeGreaterThan(callsAfterFirst); // cache expired — probed again
  });

  it("caches a negative result too (false isn't treated as 'no cache')", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      throw new Error("timeout");
    };
    const now = 0;
    const cache = new CloudMetadataCache();

    expect(await cache.get({ fetch, now: () => now })).toBe(false);
    const callsAfterFirst = calls;
    expect(await cache.get({ fetch, now: () => now })).toBe(false);
    expect(calls).toBe(callsAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Public IP on the default-route interface
// ---------------------------------------------------------------------------

let sysRoot = "";

beforeEach(() => {
  sysRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vox-net-signals-test-"));
});
afterEach(() => {
  fs.rmSync(sysRoot, { recursive: true, force: true });
});

function makeIfaceWithDevice(iface: string) {
  fs.mkdirSync(path.join(sysRoot, "sys", "class", "net", iface, "device"), { recursive: true });
}

function makeIfaceNoDevice(iface: string) {
  // A virtual interface (container veth / bridge) — the dir exists but has no `device` entry.
  fs.mkdirSync(path.join(sysRoot, "sys", "class", "net", iface), { recursive: true });
}

function makeDockerenv() {
  fs.writeFileSync(path.join(sysRoot, ".dockerenv"), "");
}

function execFake(responses: Record<string, string>): PublicIpDeps["exec"] {
  return (cmd: string) => {
    if (!(cmd in responses)) throw new Error(`unexpected exec: ${cmd}`);
    return responses[cmd];
  };
}

function deps(overrides: Partial<PublicIpDeps> & { exec: PublicIpDeps["exec"] }): PublicIpDeps {
  return { env: {}, platform: "linux", sysRoot, ...overrides };
}

describe("detectPublicIpOnInterface — env override", () => {
  it("VOX_PUBLIC_IP_ON_IFACE=true wins outright — exec is never even called", () => {
    const result = detectPublicIpOnInterface(
      deps({ env: { VOX_PUBLIC_IP_ON_IFACE: "true" }, exec: () => { throw new Error("must not be called"); } })
    );
    expect(result).toBe(true);
  });

  it("VOX_PUBLIC_IP_ON_IFACE=false wins outright too", () => {
    const result = detectPublicIpOnInterface(
      deps({ env: { VOX_PUBLIC_IP_ON_IFACE: "false" }, exec: () => { throw new Error("must not be called"); } })
    );
    expect(result).toBe(false);
  });

  it("an invalid override value is ignored — falls through to real detection", () => {
    makeIfaceWithDevice("eth0");
    const result = detectPublicIpOnInterface(
      deps({
        env: { VOX_PUBLIC_IP_ON_IFACE: "maybe" },
        exec: execFake({
          "ip route get 1.1.1.1": "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.5",
          "ip -o addr show dev eth0": `2: eth0    inet 203.0.113.5/24 brd 203.0.113.255 scope global eth0\\       valid_lft forever preferred_lft forever`,
        }),
      })
    );
    expect(result).toBe(true);
  });
});

describe("detectPublicIpOnInterface — containers", () => {
  it("/.dockerenv present → undefined, even on an otherwise-real-looking interface", () => {
    makeDockerenv();
    makeIfaceWithDevice("eth0");
    const result = detectPublicIpOnInterface(
      deps({
        exec: execFake({
          "ip route get 1.1.1.1": "1.1.1.1 via 172.17.0.1 dev eth0 src 172.17.0.2",
          "ip -o addr show dev eth0": `2: eth0    inet 203.0.113.5/24 brd 203.0.113.255 scope global eth0`,
        }),
      })
    );
    expect(result).toBeUndefined();
  });

  it("no /.dockerenv, but the default-route interface has no sysfs device entry (veth) → undefined", () => {
    makeIfaceNoDevice("eth0");
    const result = detectPublicIpOnInterface(
      deps({ exec: execFake({ "ip route get 1.1.1.1": "1.1.1.1 via 172.17.0.1 dev eth0 src 172.17.0.2" }) })
    );
    expect(result).toBeUndefined();
  });

  it("VOX_PUBLIC_IP_ON_IFACE still wins inside a container", () => {
    makeDockerenv();
    const result = detectPublicIpOnInterface(
      deps({ env: { VOX_PUBLIC_IP_ON_IFACE: "true" }, exec: () => { throw new Error("must not be called"); } })
    );
    expect(result).toBe(true);
  });
});

describe("detectPublicIpOnInterface — linux address classification", () => {
  const ROUTE = { "ip route get 1.1.1.1": "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.5" };

  it("public IPv4 on the interface → true", () => {
    makeIfaceWithDevice("eth0");
    const result = detectPublicIpOnInterface(
      deps({
        exec: execFake({
          ...ROUTE,
          "ip -o addr show dev eth0": `2: eth0    inet 203.0.113.5/24 brd 203.0.113.255 scope global eth0`,
        }),
      })
    );
    expect(result).toBe(true);
  });

  it("private IPv4 (RFC1918, 192.168.x.x) → false", () => {
    makeIfaceWithDevice("eth0");
    const result = detectPublicIpOnInterface(
      deps({
        exec: execFake({
          ...ROUTE,
          "ip -o addr show dev eth0": `2: eth0    inet 192.168.1.5/24 brd 192.168.1.255 scope global eth0`,
        }),
      })
    );
    expect(result).toBe(false);
  });

  it("CGNAT IPv4 (100.64.0.0/10) → false", () => {
    makeIfaceWithDevice("eth0");
    const result = detectPublicIpOnInterface(
      deps({
        exec: execFake({
          ...ROUTE,
          "ip -o addr show dev eth0": `2: eth0    inet 100.90.1.5/10 scope global eth0`,
        }),
      })
    );
    expect(result).toBe(false);
  });

  it("global IPv6 (2000::/3) → true", () => {
    makeIfaceWithDevice("eth0");
    const result = detectPublicIpOnInterface(
      deps({
        exec: execFake({
          ...ROUTE,
          "ip -o addr show dev eth0": `2: eth0    inet6 2001:db8::1/64 scope global`,
        }),
      })
    );
    expect(result).toBe(true);
  });

  it("link-local IPv6 (fe80::/10) only → false", () => {
    makeIfaceWithDevice("eth0");
    const result = detectPublicIpOnInterface(
      deps({
        exec: execFake({
          ...ROUTE,
          "ip -o addr show dev eth0": `2: eth0    inet6 fe80::1/64 scope link`,
        }),
      })
    );
    expect(result).toBe(false);
  });

  it("RFC1918 10.x.x.x and 172.16-31.x.x both read as private", () => {
    makeIfaceWithDevice("eth0");
    const result10 = detectPublicIpOnInterface(
      deps({ exec: execFake({ ...ROUTE, "ip -o addr show dev eth0": `2: eth0    inet 10.1.2.3/8 scope global eth0` }) })
    );
    expect(result10).toBe(false);

    const result172 = detectPublicIpOnInterface(
      deps({ exec: execFake({ ...ROUTE, "ip -o addr show dev eth0": `2: eth0    inet 172.20.0.5/16 scope global eth0` }) })
    );
    expect(result172).toBe(false);
  });

  it("loopback and no default route → undefined, never thrown", () => {
    const result = detectPublicIpOnInterface(deps({ exec: () => { throw new Error("no route"); } }));
    expect(result).toBeUndefined();
  });
});

describe("detectPublicIpOnInterface — unsupported platform", () => {
  it("returns undefined without calling exec", () => {
    const result = detectPublicIpOnInterface(deps({ platform: "win32", exec: () => { throw new Error("must not be called"); } }));
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// withNetSignals wire helper
// ---------------------------------------------------------------------------

describe("withNetSignals", () => {
  it("includes only the fields that were detected", () => {
    const body = withNetSignals({ name: "agent-1" }, { cloudMetadata: true, publicIpOnInterface: undefined });
    expect(body).toEqual({ name: "agent-1", netSignals: { cloudMetadata: true } });
  });

  it("omits netSignals entirely when nothing was detected", () => {
    const body = withNetSignals({ name: "agent-1" }, { cloudMetadata: undefined, publicIpOnInterface: undefined });
    expect(body).toEqual({ name: "agent-1" });
  });

  it("includes both fields when both are detected", () => {
    const body = withNetSignals({ name: "agent-1" }, { cloudMetadata: true, publicIpOnInterface: false });
    expect(body).toEqual({ name: "agent-1", netSignals: { cloudMetadata: true, publicIpOnInterface: false } });
  });
});
