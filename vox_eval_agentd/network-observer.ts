import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { detectLinkType, isValidInterfaceName } from "./link-type";
import { LINK_VALUES, type LinkType } from "../shared/tags";
import type { NetworkObservation } from "./network-events";

const exec = (file: string, args: readonly string[]) => execFileSync(file, args, { encoding: "utf8", timeout: 500, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] });

/** Host observations can cross a read-only mount, but private fingerprints
 * never cross the agent/Core API. Missing/stale evidence fails closed. */
export class NetworkObserver {
  private hostSeq?: number;
  private hostMonitor?: string;
  private hostGaps?: number;
  public publicIpOnInterface?: boolean;
  sample(): { observations: NetworkObservation[]; gap: boolean; transitionCount?: number } {
    try {
      const hostFile = process.env.VOX_NETWORK_STATUS_FILE;
      if (hostFile) {
        if (fs.statSync(hostFile).size > 128 * 1024) throw new Error("Oversized host status");
        const status = JSON.parse(fs.readFileSync(hostFile, "utf8"));
        if (status.version !== 1 || !Number.isSafeInteger(status.seq) || typeof status.monitor !== "string"
          || !Array.isArray(status.events) || status.events.length > 128
          || !Number.isSafeInteger(status.timestamp) || !Number.isSafeInteger(status.gapCount)
          || !/^[a-f0-9]{64}$/.test(status.fingerprint) || !(LINK_VALUES as readonly string[]).includes(status.link)
          || Math.abs(Date.now() - status.timestamp) > 5000 || !status.available) throw new Error("Stale or invalid host status");
        let gap = this.hostMonitor !== undefined && (this.hostMonitor !== status.monitor || status.seq < this.hostSeq! || status.gapCount !== this.hostGaps);
        const after = this.hostMonitor === status.monitor ? this.hostSeq : undefined;
        const events = status.events.filter((event: any) => after === undefined ? event.seq === status.seq : event.seq > after);
        const missingChanges = after === undefined ? 0 : Math.max(0, status.seq - after - events.length);
        if (missingChanges > 0) gap = true;
        const observations = events.map((event: any) => {
          if (!Number.isSafeInteger(event.seq) || !/^[a-f0-9]{64}$/.test(event.fingerprint)
            || !(LINK_VALUES as readonly string[]).includes(event.link) || !Number.isSafeInteger(event.timestamp)) throw new Error("Invalid host observation");
          return { link: event.link as LinkType, fingerprint: event.fingerprint, timestamp: event.timestamp };
        });
        this.hostSeq = status.seq;
        this.hostMonitor = status.monitor;
        this.hostGaps = status.gapCount;
        this.publicIpOnInterface = typeof status.publicIpOnInterface === "boolean" ? status.publicIpOnInterface : undefined;
        // An unchanged, fresh host status still proves the sampler is alive.
        if (!observations.length) observations.push({ link: status.link, fingerprint: status.fingerprint, timestamp: status.timestamp });
        return { observations, gap, ...(after === undefined ? {} : { transitionCount: Math.max(0, status.seq - after) }) };
      }
      if (fs.existsSync("/.dockerenv")) return { observations: [], gap: true };
      const link = detectLinkType({ env: {}, platform: process.platform, sysRoot: "", exec });
      if (!link) return { observations: [], gap: true };
      let fingerprint: string;
      if (process.platform === "linux") {
        const route = exec("ip", ["route", "get", "1.1.1.1"]);
        const iface = route.match(/\bdev\s+(\S+)/)?.[1];
        if (!isValidInterfaceName(iface)) return { observations: [], gap: true };
        fingerprint = [iface, route.match(/\bvia\s+(\S+)/)?.[1], route.match(/\bsrc\s+(\S+)/)?.[1]].join("|");
        if (link === "wifi") {
          try { fingerprint += exec("iw", ["dev", iface, "link"]).match(/Connected to (\S+)/)?.[1] ?? ""; } catch { /* route still monitored */ }
        }
      } else if (process.platform === "darwin") {
        const route = exec("route", ["-n", "get", "default"]);
        const iface = route.match(/^\s*interface:\s*(\S+)/m)?.[1];
        if (!isValidInterfaceName(iface)) return { observations: [], gap: true };
        fingerprint = `${iface}|${route.match(/^\s*gateway:\s*(\S+)/m)?.[1]}|${exec("ifconfig", [iface]).match(/inet\s+(\S+)/)?.[1]}`;
      } else return { observations: [], gap: true };
      return { observations: [{ link, fingerprint: createHash("sha256").update(fingerprint).digest("hex") }], gap: false };
    } catch { this.publicIpOnInterface = undefined; return { observations: [], gap: true }; }
  }
}
