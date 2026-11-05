import { describe, it, expect } from "vitest";
import {
  classifyAccess, matchRdns, reverseDnsName, ACCESS_CLASSIFIER_VERSION, EYEBALL_MIN_SHARE,
  type AccessInput,
} from "../server/access-class";

// Baseline: data loaded, public IP, no signal of any kind.
const base = (over: Partial<AccessInput> = {}): AccessInput => ({
  dataLoaded: true,
  ipPublic: true,
  isTor: false,
  netClass: null,
  peeringdbType: undefined,
  eyeballShare: undefined,
  isMobile: false,
  rdns: null,
  agent: {},
  ...over,
});

// Real reverse-DNS names (each pattern below is justified by one of these).
const RES_RDNS = "cpe-66-75-1-1.socal.res.rr.com";           // Charter Spectrum
const SERVER_RDNS = "static.88.198.1.1.clients.your-server.de"; // Hetzner
const GENERIC_RDNS = "12.34.56.78.ptr.example-telco.net";       // nothing either way
const EYEBALL = 17.89; // Comcast AS7922's APNIC share of US users

describe("classifyAccess decision rule", () => {
  it("version is v1", () => expect(ACCESS_CLASSIFIER_VERSION).toBe("v1"));

  it("Tor exit → unknown", () => {
    expect(classifyAccess(base({ isTor: true, isMobile: true }))).toEqual({ access: "unknown", reason: "v1: tor" });
  });
  it("VPN range → unknown (even with lastmile evidence)", () => {
    expect(classifyAccess(base({ netClass: "vpn", eyeballShare: EYEBALL, rdns: RES_RDNS })))
      .toEqual({ access: "unknown", reason: "v1: vpn-range" });
  });
  it("datacenter range → datacenter", () => {
    expect(classifyAccess(base({ netClass: "hosting" }))).toEqual({ access: "datacenter", reason: "v1: dc-range" });
  });
  it("PeeringDB Content → datacenter", () => {
    expect(classifyAccess(base({ peeringdbType: "content" }))).toEqual({ access: "datacenter", reason: "v1: pdb-content" });
  });
  it("server-style rDNS → datacenter", () => {
    expect(classifyAccess(base({ rdns: SERVER_RDNS }))).toEqual({ access: "datacenter", reason: "v1: server-rdns" });
  });
  it("agent cloud metadata → datacenter", () => {
    expect(classifyAccess(base({ agent: { cloudMetadata: true } }))).toEqual({ access: "datacenter", reason: "v1: cloud-metadata" });
  });
  it("every datacenter signal present is listed, in a stable order", () => {
    expect(classifyAccess(base({
      netClass: "hosting", peeringdbType: "content", rdns: SERVER_RDNS, agent: { cloudMetadata: true },
    })).reason).toBe("v1: dc-range + pdb-content + server-rdns + cloud-metadata");
  });

  it("mobile-carrier ASN alone → lastmile", () => {
    expect(classifyAccess(base({ isMobile: true }))).toEqual({ access: "lastmile", reason: "v1: mobile-asn" });
  });
  it("eyeball ASN + residential rDNS → lastmile", () => {
    expect(classifyAccess(base({ eyeballShare: EYEBALL, rdns: RES_RDNS })))
      .toEqual({ access: "lastmile", reason: "v1: eyeball-asn + residential-rdns" });
  });
  it("PeeringDB Cable/DSL/ISP + residential rDNS → lastmile", () => {
    expect(classifyAccess(base({ peeringdbType: "access", rdns: RES_RDNS })))
      .toEqual({ access: "lastmile", reason: "v1: pdb-access + residential-rdns" });
  });
  it("eyeball ASN alone → unknown (one weak signal is never enough)", () => {
    expect(classifyAccess(base({ eyeballShare: EYEBALL })))
      .toEqual({ access: "unknown", reason: "v1: insufficient + eyeball-asn" });
  });
  it("residential rDNS alone → unknown", () => {
    expect(classifyAccess(base({ rdns: RES_RDNS })))
      .toEqual({ access: "unknown", reason: "v1: insufficient + residential-rdns" });
  });
  it("AT&T colo: access network with a generic rDNS name → unknown", () => {
    // AS7018 is an access network (APNIC 12.12% of US users), but a colo
    // server's PTR carries no residential token.
    expect(classifyAccess(base({ eyeballShare: 12.12, peeringdbType: "access", rdns: GENERIC_RDNS })))
      .toEqual({ access: "unknown", reason: "v1: insufficient + eyeball-asn + pdb-access" });
  });
  it("eyeball share below the threshold is not access-network evidence (AWS's 4.93% somewhere)", () => {
    expect(EYEBALL_MIN_SHARE).toBeGreaterThan(0);
    expect(classifyAccess(base({ eyeballShare: EYEBALL_MIN_SHARE - 0.01, rdns: RES_RDNS })).access).toBe("unknown");
    expect(classifyAccess(base({ eyeballShare: EYEBALL_MIN_SHARE, rdns: RES_RDNS })).access).toBe("lastmile");
  });
  it("a datacenter signal beats lastmile evidence (rule 2 before rule 3)", () => {
    expect(classifyAccess(base({ netClass: "hosting", eyeballShare: EYEBALL, rdns: RES_RDNS })))
      .toEqual({ access: "datacenter", reason: "v1: dc-range" });
    expect(classifyAccess(base({ isMobile: true, agent: { cloudMetadata: true } })))
      .toEqual({ access: "datacenter", reason: "v1: cloud-metadata" });
    // rDNS with both a server and a residential token: server wins.
    expect(classifyAccess(base({ eyeballShare: EYEBALL, rdns: "vps-12.dyn.example.net" })).access).toBe("datacenter");
  });
  it("public IP on the interface turns lastmile into unknown (disagreement → unknown)", () => {
    expect(classifyAccess(base({ isMobile: true, agent: { publicIpOnInterface: true } })))
      .toEqual({ access: "unknown", reason: "v1: public-ip-on-iface + mobile-asn" });
    expect(classifyAccess(base({ eyeballShare: EYEBALL, rdns: RES_RDNS, agent: { publicIpOnInterface: true } })).access)
      .toBe("unknown");
    // false means the agent checked and found none — no effect.
    expect(classifyAccess(base({ isMobile: true, agent: { publicIpOnInterface: false } })).access).toBe("lastmile");
  });
  it("no data (VPN/datacenter lists unloaded) → unknown, never lastmile", () => {
    expect(classifyAccess(base({ dataLoaded: false, isMobile: true, eyeballShare: EYEBALL, rdns: RES_RDNS })))
      .toEqual({ access: "unknown", reason: "v1: no-data" });
    expect(classifyAccess(base({ dataLoaded: false, netClass: "hosting" })).access).toBe("unknown");
  });
  it("no signals at all → unknown insufficient", () => {
    expect(classifyAccess(base())).toEqual({ access: "unknown", reason: "v1: insufficient" });
  });
  it("private IP → unknown", () => {
    expect(classifyAccess(base({ ipPublic: false, isMobile: true }))).toEqual({ access: "unknown", reason: "v1: private-ip" });
  });

  it("agent signals can never produce lastmile (property over every core × agent combination)", () => {
    const tri = [undefined, true, false] as const;
    const agents = tri.flatMap((cloudMetadata) => tri.map((publicIpOnInterface) => {
      const a: AccessInput["agent"] = {};
      if (cloudMetadata !== undefined) a.cloudMetadata = cloudMetadata;
      if (publicIpOnInterface !== undefined) a.publicIpOnInterface = publicIpOnInterface;
      return a;
    }));
    let checked = 0;
    for (const dataLoaded of [true, false])
    for (const ipPublic of [true, false])
    for (const isTor of [false, true])
    for (const netClass of [null, "vpn", "hosting"] as const)
    for (const peeringdbType of [undefined, "access", "content", "enterprise", "other"] as const)
    for (const eyeballShare of [undefined, 0, 4.93, EYEBALL])
    for (const isMobile of [false, true])
    for (const rdns of [null, RES_RDNS, SERVER_RDNS, GENERIC_RDNS]) {
      const core = { dataLoaded, ipPublic, isTor, netClass, peeringdbType, eyeballShare, isMobile, rdns };
      const without = classifyAccess({ ...core, agent: {} }).access;
      for (const agent of agents) {
        const withAgent = classifyAccess({ ...core, agent }).access;
        // Agent signals only ever move a result toward datacenter or unknown.
        if (withAgent === "lastmile") expect(without).toBe("lastmile");
        if (without !== "lastmile") expect(withAgent).not.toBe("lastmile");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10000);
  });

  it("reason strings always carry the version prefix", () => {
    for (const input of [base(), base({ isMobile: true }), base({ netClass: "hosting" }), base({ isTor: true })]) {
      expect(classifyAccess(input).reason).toMatch(/^v1: [a-z-]+( \+ [a-z-]+)*$/);
    }
  });
});

describe("reverse-DNS patterns (real-world names)", () => {
  it.each([
    ["108-200-1-1.lightspeed.sntcca.sbcglobal.net", "residential"], // AT&T U-verse
    ["pool-71-174-1-1.bstnma.fios.verizon.net", "residential"],     // Verizon Fios
    ["cpe-66-75-1-1.socal.res.rr.com", "residential"],              // Charter Spectrum
    ["c-73-15-1-1.hsd1.ca.comcast.net", "residential"],             // Comcast Xfinity
    ["p5b0a1234.dip0.t-ipconnect.de", "residential"],               // Deutsche Telekom
    ["adsl-99-1-2-3.dsl.chcgil.sbcglobal.net", "residential"],      // AT&T DSL
    ["cpc123-sgyl1-2-0-cust456.18-2.cable.virginm.net", "residential"], // Virgin Media
    ["ool-18e41234.dyn.optonline.net", "residential"],              // Optimum
    ["abts-north-dynamic-123.4.5.6.airtelbroadband.in", "residential"], // Airtel broadband
    ["d14-69-1-1.try.wideopenwest.com", null],                      // WOW: generic, no token
    ["static.88.198.1.1.clients.your-server.de", "server"],         // Hetzner
    ["vps-1234abcd.vps.ovh.net", "server"],                         // OVH VPS
    ["ec2-3-1-2-3.compute-1.amazonaws.com", "server"],              // AWS EC2
    ["1-2-3-4.instances.scw.cloud", "server"],                      // Scaleway
    ["hosted-by.leaseweb.com", "server"],                           // Leaseweb
    ["colo-1-2-3-4.example-dc.net", "server"],
    ["dedicated.example-host.com", "server"],
    ["ns3001234.ip-51-75-1.eu", null],                              // OVH dedicated: no token
    ["12.34.56.78.ptr.example-telco.net", null],
    ["resolver.example.net", null],                                 // "res" only as a whole label
    ["poolside.example.com", null],
  ])("%s → %s", (name, expected) => {
    expect(matchRdns(name)).toBe(expected);
  });
  it("server tokens win when a name carries both", () => {
    expect(matchRdns("vps-12.dyn.example.net")).toBe("server");
  });
});

describe("reverseDnsName (injected resolver)", () => {
  it("returns the first PTR name, lowercased", async () => {
    expect(await reverseDnsName("1.2.3.4", { reverse: async () => ["CPE-1-2-3-4.Res.RR.com", "other"] })).toBe("cpe-1-2-3-4.res.rr.com");
  });
  it("failure or no answer → null", async () => {
    expect(await reverseDnsName("1.2.3.4", { reverse: async () => { throw new Error("ENOTFOUND"); } })).toBeNull();
    expect(await reverseDnsName("1.2.3.4", { reverse: async () => [] })).toBeNull();
  });
  it("timeout → null within the bound", async () => {
    const started = Date.now();
    const name = await reverseDnsName("1.2.3.4", { reverse: () => new Promise(() => {}), timeoutMs: 50 });
    expect(name).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
