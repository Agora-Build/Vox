/**
 * Last mile vs datacenter (`access`) — designs/2026-10-22-network-tags-design.md
 * "Decision rule". Pure: every signal is gathered by the location pipeline
 * (server/location.ts) and passed in; this module only decides.
 *
 *   1. Tor / VPN → unknown.
 *   2. Any datacenter signal (datacenter range, PeeringDB Content, server-style
 *      rDNS, cloud metadata) → datacenter.
 *   3. No datacenter signal, the agent reports nothing contrary (no public IP
 *      on the interface), and either a mobile-carrier ASN, or two independent
 *      Core signals — an access network (APNIC end-user share or PeeringDB
 *      Cable/DSL/ISP) AND a residential rDNS name → lastmile.
 *   4. Otherwise unknown.
 *
 * Only Core signals can earn `lastmile`; agent signals can only push toward
 * `datacenter` (cloud metadata) or `unknown` (public IP on the interface).
 * Missing data ⇒ fewer signals ⇒ more unknown, never a wrong lastmile.
 */
import { promises as dnsPromises } from "dns";
import type { PeeringdbType } from "./access-data";

export const ACCESS_CLASSIFIER_VERSION = "v1";

export type AccessClass = "lastmile" | "datacenter" | "unknown";
export interface AccessResult { access: AccessClass; reason: string }

export interface AgentNetSignals {
  /** A cloud metadata service answered from the agent (169.254.169.254 / metadata.google.internal). */
  cloudMetadata?: boolean;
  /** The agent host's default interface holds a public address (no home router). */
  publicIpOnInterface?: boolean;
}

export interface AccessInput {
  /** The VPN + datacenter range lists have loaded. False ⇒ unknown (`no-data`). */
  dataLoaded: boolean;
  ipPublic: boolean;
  isTor: boolean;
  /** "vpn" = in a VPN range; "hosting" = in a datacenter IP range. */
  netClass: "vpn" | "hosting" | null;
  peeringdbType: PeeringdbType | undefined;
  /** APNIC share (percent) — see AccessData.eyeballShare. */
  eyeballShare: number | undefined;
  isMobile: boolean;
  /** First PTR name, lowercase; null when none/failed/timed out. */
  rdns: string | null;
  agent: AgentNetSignals;
}

/**
 * APNIC end-user share (percent of one country's Internet users, counting
 * only countries where the AS serves ≥ APNIC_MIN_COUNTRY_USERS — see
 * server/access-data.ts parseApnicAspop) at or above which the AS counts as
 * an access network. Chosen from the 2026-10-20 aspop data: of the 168 ASNs
 * holding ≥ a /16 of X4BNet datacenter/VPN ranges, none but UFINET Panama (a
 * real access carrier) reaches 1% under that floor — AWS's 4.93% (SG) is a
 * 252k-user row, Google tops out at 0.52%, GTHost 0.49%; while Verizon 4.72%,
 * Cox 3.22%, Frontier 1.98%, Charter's regional ASNs ~1.5%, CenturyLink 1.4%
 * all pass. Smaller ISPs fall below and stay `unknown` (safe direction).
 */
export const EYEBALL_MIN_SHARE = 1.0;

// ==================== Reverse DNS ====================
// A PTR name is split into labels on "." and "-"; a pattern must match a
// WHOLE label, so "res" doesn't fire inside "resolver" and "pool" doesn't
// fire inside "poolside". Each pattern carries a real example name.

const RESIDENTIAL_LABELS: RegExp[] = [
  /^lightspeed$/,      // 108-200-1-1.lightspeed.sntcca.sbcglobal.net (AT&T U-verse)
  /^fios$/,            // pool-71-174-1-1.bstnma.fios.verizon.net (Verizon Fios)
  /^pool$/,            // pool-71-174-1-1.bstnma.fios.verizon.net
  /^res$/,             // cpe-66-75-1-1.socal.res.rr.com (Charter Spectrum)
  /^cpe$/,             // cpe-66-75-1-1.socal.res.rr.com
  /^hsd\d*$/,          // c-73-15-1-1.hsd1.ca.comcast.net (Comcast "high-speed data")
  /^dip\d*$/,          // p5b0a1234.dip0.t-ipconnect.de (Deutsche Telekom dial-in IP)
  /^[avx]?dsl\d*$/,    // adsl-99-1-2-3.dsl.chcgil.sbcglobal.net (AT&T DSL)
  /^cable$/,           // cpc123-sgyl1-2-0-cust456.18-2.cable.virginm.net (Virgin Media)
  /^cust\d+$/,         // cpc123-sgyl1-2-0-cust456.18-2.cable.virginm.net
  /^dyn(amic)?\d*$/,   // ool-18e41234.dyn.optonline.net (Optimum); abts-north-dynamic-…airtelbroadband.in
  /^dhcp\d*$/,         // dhcp-…: ISP-assigned dynamic address
  /broadband/,         // abts-north-dynamic-123.4.5.6.airtelbroadband.in (Airtel broadband)
  /^ftth$/,            // ftth-…: fibre to the home
];

const SERVER_LABELS: RegExp[] = [
  /^servers?\d*$/,     // static.88.198.1.1.clients.your-server.de (Hetzner)
  /^vps\d*$/,          // vps-1234abcd.vps.ovh.net (OVH VPS)
  /^compute$/,         // ec2-3-1-2-3.compute-1.amazonaws.com (AWS EC2)
  /^cloud$/,           // 1-2-3-4.instances.scw.cloud (Scaleway)
  /^instances$/,       // 1-2-3-4.instances.scw.cloud
  /^hosted$/,          // hosted-by.leaseweb.com (Leaseweb)
  /^hosting$/,         // …hosting…: web/colo hosting
  /^colo(cation)?\d*$/, // colo-…: colocation
  /^dedi(cated)?\d*$/, // dedicated.…: dedicated server
];

/** "server" when any label is server-style (wins), else "residential", else null. */
export function matchRdns(name: string | null): "server" | "residential" | null {
  if (!name) return null;
  const labels = name.toLowerCase().split(/[.-]/).filter(Boolean);
  if (labels.some((l) => SERVER_LABELS.some((re) => re.test(l)))) return "server";
  if (labels.some((l) => RESIDENTIAL_LABELS.some((re) => re.test(l)))) return "residential";
  return null;
}

export const RDNS_TIMEOUT_MS = 1500;

/**
 * First PTR name of `ip`, lowercased; null on no answer, failure or timeout —
 * a missing rDNS is just a missing signal. `reverse` is injectable for tests.
 */
export async function reverseDnsName(
  ip: string,
  opts: { reverse?: (ip: string) => Promise<string[]>; timeoutMs?: number } = {},
): Promise<string | null> {
  const reverse = opts.reverse ?? ((addr: string) => dnsPromises.reverse(addr));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), opts.timeoutMs ?? RDNS_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const names = await Promise.race([reverse(ip).catch(() => null), timeout]);
    const first = names?.[0];
    return typeof first === "string" && first.length > 0 ? first.toLowerCase() : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ==================== Decision ====================

const reason = (signals: string[]): string => `${ACCESS_CLASSIFIER_VERSION}: ${signals.join(" + ")}`;

export function classifyAccess(input: AccessInput): AccessResult {
  const unknown = (signals: string[]): AccessResult => ({ access: "unknown", reason: reason(signals) });

  if (!input.ipPublic) return unknown(["private-ip"]);
  if (!input.dataLoaded) return unknown(["no-data"]);

  // 1. The real path is hidden.
  if (input.isTor) return unknown(["tor"]);
  if (input.netClass === "vpn") return unknown(["vpn-range"]);

  const rdnsKind = matchRdns(input.rdns);

  // 2. Any datacenter signal wins — before any lastmile evidence is looked at.
  const dc: string[] = [];
  if (input.netClass === "hosting") dc.push("dc-range");
  if (input.peeringdbType === "content") dc.push("pdb-content");
  if (rdnsKind === "server") dc.push("server-rdns");
  if (input.agent.cloudMetadata === true) dc.push("cloud-metadata");
  if (dc.length > 0) return { access: "datacenter", reason: reason(dc) };

  // 3. Core-only lastmile evidence.
  const evidence: string[] = [];
  if (input.isMobile) evidence.push("mobile-asn");
  if (input.eyeballShare !== undefined && input.eyeballShare >= EYEBALL_MIN_SHARE) evidence.push("eyeball-asn");
  if (input.peeringdbType === "access") evidence.push("pdb-access");
  if (rdnsKind === "residential") evidence.push("residential-rdns");

  const accessNetwork = evidence.includes("eyeball-asn") || evidence.includes("pdb-access");
  const twoCoreSignals = accessNetwork && evidence.includes("residential-rdns");
  const earned = input.isMobile ? ["mobile-asn"] : twoCoreSignals ? evidence : null;

  if (earned) {
    // The agent's contrary report only ever downgrades.
    if (input.agent.publicIpOnInterface === true) return unknown(["public-ip-on-iface", ...earned]);
    return { access: "lastmile", reason: reason(earned) };
  }
  // 4.
  return unknown(["insufficient", ...evidence]);
}
