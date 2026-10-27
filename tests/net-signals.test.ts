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

type Answer = { status: number; headers?: Record<string, string>; body?: string } | "timeout";

/** A response-shaped object, as the probes read it (status, headers, text()). */
function respond(a: Exclude<Answer, "timeout">) {
  const headers = Object.fromEntries(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { status: a.status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => a.body ?? "" };
}

/** A fake fetch keyed by "METHOD URL" (GET when no method); absent/"timeout" →
 *  throws, simulating a timeout/connection failure without any real wait.
 *  Records each call's init so tests can check what was sent. */
function fakeFetch(answers: Record<string, Answer>, calls: Array<{ key: string; init: Parameters<FetchLike>[1] }> = []): FetchLike {
  return async (url, init) => {
    const key = `${init.method ?? "GET"} ${url}`;
    calls.push({ key, init });
    const a = answers[key] ?? "timeout";
    if (a === "timeout") throw new Error("timed out");
    return respond(a);
  };
}

const AWS_TOKEN = "PUT http://169.254.169.254/latest/api/token";
const AWS_META = "GET http://169.254.169.254/latest/meta-data/";
const AZURE = "GET http://169.254.169.254/metadata/instance?api-version=2021-02-01";
const GCP = "GET http://metadata.google.internal/computeMetadata/v1/";
const ALL = [AWS_TOKEN, AWS_META, AZURE, GCP];
const everyProbe = (a: Answer) => Object.fromEntries(ALL.map((k) => [k, a]));
const probe = (answers: Record<string, Answer>) => probeCloudMetadata({ fetch: fakeFetch(answers), now: () => 0 });

describe("probeCloudMetadata — only a provider's signature counts", () => {
  it("AWS IMDSv2: the token PUT answered 200 with a token → true, with the TTL header sent", async () => {
    const calls: Array<{ key: string; init: Parameters<FetchLike>[1] }> = [];
    const fetch = fakeFetch({ [AWS_TOKEN]: { status: 200, body: "AQAEAHnEXAMPLEtoken_abc123-xyz==" } }, calls);
    expect(await probeCloudMetadata({ fetch, now: () => 0 })).toBe(true);
    expect(calls.find((c) => c.key === AWS_TOKEN)?.init.headers).toEqual({ "X-aws-ec2-metadata-token-ttl-seconds": "21600" });
  });

  it("AWS IMDSv1: a meta-data listing naming instance-id → true", async () => {
    expect(await probe({ [AWS_META]: { status: 200, body: "ami-id\nhostname\ninstance-id\nlocal-ipv4\n" } })).toBe(true);
  });

  it("AWS 401 alone (no token, no listing) is no longer enough → false", async () => {
    expect(await probe({ [AWS_TOKEN]: { status: 401 }, [AWS_META]: { status: 401 } })).toBe(false);
  });

  it("Azure: 200 with a compute object → true", async () => {
    expect(await probe({ [AZURE]: { status: 200, body: JSON.stringify({ compute: { vmId: "x" }, network: {} }) } })).toBe(true);
  });

  it("Azure: 200 JSON without compute → false", async () => {
    expect(await probe({ [AZURE]: { status: 200, body: JSON.stringify({ ok: true }) } })).toBe(false);
  });

  it("GCP: 200 with Metadata-Flavor: Google → true", async () => {
    expect(await probe({ [GCP]: { status: 200, headers: { "Metadata-Flavor": "Google" }, body: "instance/\nproject/\n" } })).toBe(true);
  });

  it("GCP: 200 without the Metadata-Flavor header → false", async () => {
    expect(await probe({ [GCP]: { status: 200, body: "instance/\nproject/\n" } })).toBe(false);
  });

  it("a transparent proxy answering every URL 200 with an HTML page → false", async () => {
    expect(await probe(everyProbe({ status: 200, headers: { "Content-Type": "text/html" }, body: "<!doctype html><html><body>Blocked by policy</body></html>" }))).toBe(false);
  });

  it("a captive portal answering every URL 302 → false, and redirects are never followed", async () => {
    const calls: Array<{ key: string; init: Parameters<FetchLike>[1] }> = [];
    const fetch = fakeFetch(everyProbe({ status: 302, headers: { Location: "http://portal.example/login" } }), calls);
    expect(await probeCloudMetadata({ fetch, now: () => 0 })).toBe(false);
    expect(calls.every((c) => c.init.redirect === "manual")).toBe(true);
  });

  it("an NXDOMAIN-hijacking ISP's search page (200, HTML) on the GCP name → false", async () => {
    expect(await probe({ [GCP]: { status: 200, body: "<html>Did you mean metadata.google.com?</html>" } })).toBe(false);
  });

  it("all probes fail/time out → false", async () => {
    expect(await probe({})).toBe(false);
  });
});

describe("CloudMetadataCache", () => {
  it("caches a positive result for 10 minutes — the second call within the window never calls fetch again", async () => {
    let calls = 0;
    const fetch: FetchLike = async (url, init) => {
      calls++;
      return `${init.method ?? "GET"} ${url}` === AWS_META ? respond({ status: 200, body: "instance-id\n" }) : (() => { throw new Error("timeout"); })();
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
    const fetch: FetchLike = async (url, init) => {
      calls++;
      return `${init.method ?? "GET"} ${url}` === AWS_META ? respond({ status: 200, body: "instance-id\n" }) : (() => { throw new Error("timeout"); })();
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
  // exec is (file, args) with no shell; key the canned answers by the joined
  // command line for readability.
  return (file: string, args: readonly string[]) => {
    const cmd = [file, ...args].join(" ");
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

  // IPv6 says nothing about a home router: dual-stack home ISPs and IPv6
  // mobile hotspots give every device a global 2000::/3 address.
  it("home dual-stack: RFC1918 IPv4 + global IPv6 → false (only IPv4 counts)", () => {
    makeIfaceWithDevice("eth0");
    const result = detectPublicIpOnInterface(
      deps({
        exec: execFake({
          ...ROUTE,
          "ip -o addr show dev eth0": [
            `2: eth0    inet 192.168.1.5/24 brd 192.168.1.255 scope global dynamic eth0`,
            `2: eth0    inet6 2601:646:8a00:1f0::5/128 scope global dynamic`,
            `2: eth0    inet6 2601:646:8a00:1f0:1c2b:3dff:fe4e:5f60/64 scope global dynamic mngtmpaddr`,
            `2: eth0    inet6 fe80::1c2b:3dff:fe4e:5f60/64 scope link`,
          ].join("\n"),
        }),
      })
    );
    expect(result).toBe(false);
  });

  it("IPv6-only host (global IPv6, no IPv4 at all) → undefined: nothing to judge by, so no claim either way", () => {
    makeIfaceWithDevice("eth0");
    const result = detectPublicIpOnInterface(
      deps({
        exec: execFake({
          ...ROUTE,
          "ip -o addr show dev eth0": `2: eth0    inet6 2001:db8::1/64 scope global`,
        }),
      })
    );
    expect(result).toBeUndefined();
  });

  it("macOS dual-stack (ifconfig): private IPv4 + global IPv6 → false", () => {
    const result = detectPublicIpOnInterface(
      deps({
        platform: "darwin",
        exec: execFake({
          "route -n get default": "   route to: default\n  gateway: 192.168.1.1\n  interface: en0\n",
          "ifconfig en0": "en0: flags=8863<UP>\n\tinet6 2600:1700:abcd::12 prefixlen 64 autoconf secured\n\tinet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255\n",
        }),
      })
    );
    expect(result).toBe(false);
  });

  it("link-local IPv6 (fe80::/10) only → undefined (no IPv4 to judge by)", () => {
    makeIfaceWithDevice("eth0");
    const result = detectPublicIpOnInterface(
      deps({
        exec: execFake({
          ...ROUTE,
          "ip -o addr show dev eth0": `2: eth0    inet6 fe80::1/64 scope link`,
        }),
      })
    );
    expect(result).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Interface names never reach a shell (PR #258 review round 3)
// ---------------------------------------------------------------------------

describe("detectPublicIpOnInterface — hostile interface names", () => {
  function recordingExec(responses: Record<string, string>) {
    const calls: { file: string; args: readonly string[] }[] = [];
    const exec: PublicIpDeps["exec"] = (file, args) => {
      calls.push({ file, args });
      const cmd = [file, ...args].join(" ");
      if (!(cmd in responses)) throw new Error(`unexpected exec: ${cmd}`);
      return responses[cmd];
    };
    return { exec, calls };
  }

  it("linux: a default-route interface with shell metacharacters is never used → undefined", () => {
    // No `/` so a matching /sys entry can exist: only the name check stops it.
    const evil = "eth0;rm$IFS-rf$IFS~;`reboot`";
    makeIfaceWithDevice(evil);
    const { exec, calls } = recordingExec({ "ip route get 1.1.1.1": `1.1.1.1 via 192.168.1.1 dev ${evil} src 192.168.1.5` });
    const result = detectPublicIpOnInterface(deps({ exec }));
    expect(result).toBeUndefined();
    // Only the route lookups ran; the name never became an argument.
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain("rm$IFS");
      expect(c.args.join(" ")).not.toContain("reboot");
    }
    expect(calls.every((c) => c.file === "ip" && c.args.join(" ") === "route get 1.1.1.1")).toBe(true);
  });

  it("linux: a path-traversal name (`..`) is rejected, not joined into /sys", () => {
    const { exec, calls } = recordingExec({ "ip route get 1.1.1.1": "1.1.1.1 via 192.168.1.1 dev .. src 192.168.1.5" });
    expect(detectPublicIpOnInterface(deps({ exec }))).toBeUndefined();
    expect(calls.some((c) => c.args.includes(".."))).toBe(false);
  });

  it("darwin: a hostile interface name never reaches ifconfig → undefined", () => {
    const { exec, calls } = recordingExec({ "route -n get default": "  interface: en0$(touch$IFS/tmp/pwned)\n" });
    expect(detectPublicIpOnInterface(deps({ platform: "darwin", exec }))).toBeUndefined();
    expect(calls.map((c) => c.file)).toEqual(["route"]);
  });

  it("a valid name is passed as ONE argument (argument array, no shell string)", () => {
    makeIfaceWithDevice("veth1@if5");
    const { exec, calls } = recordingExec({
      "ip route get 1.1.1.1": "1.1.1.1 via 192.168.1.1 dev veth1@if5 src 192.168.1.5",
      "ip -o addr show dev veth1@if5": "2: veth1    inet 203.0.113.7/24 scope global veth1",
    });
    expect(detectPublicIpOnInterface(deps({ exec }))).toBe(true);
    expect(calls.at(-1)).toEqual({ file: "ip", args: ["-o", "addr", "show", "dev", "veth1@if5"] });
  });

  it("the daemon wires exec to execFileSync (no shell), never execSync", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "vox_eval_agentd", "vox-agentd.ts"), "utf8");
    expect(src).not.toMatch(/\bexecSync\s*\(/);
    expect(src.match(/exec: \(file, args\) => execFileSync\(file, args,/g)?.length).toBe(2);
  });
});
