import dns from "dns";
import net from "net";
import https from "https";
import http from "http";
import { NodeHttpHandler } from "@smithy/node-http-handler";

// Core connects to a user's own storage endpoint for Tools → Analyze (upload,
// download, delete). The user types that endpoint, so Core must never be
// steered into its own network by it: loopback, private ranges, link-local
// (cloud metadata), CGNAT and the like are refused — by the URL, and by what
// its name resolves to on every connection (so a name that later resolves
// inside is refused too). Local development against MinIO on localhost can
// opt out with VOX_STORAGE_ALLOW_PRIVATE=1, like REST_BROKER_ALLOW_PRIVATE.

const allowPrivate = () => process.env.VOX_STORAGE_ALLOW_PRIVATE === "1";

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
];
const v4ToInt = (ip: string) => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

/** Whether Core must not connect to this address. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const h = ip.toLowerCase();
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return h === "::" || h === "::1" || /^fe[89ab]/.test(h) || /^f[cd]/.test(h) || h.startsWith("ff");
  }
  return true; // not an address at all
}

/** Throws when Core may not use this storage endpoint. */
export function checkStorageEndpoint(raw: string): void {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("The storage endpoint is not a valid URL."); }
  if (allowPrivate()) return;
  if (url.protocol !== "https:") throw new Error("Analyze needs storage at a public HTTPS address.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || (net.isIP(host) && isBlockedAddress(host))) {
    throw new Error("Analyze needs storage at a public HTTPS address.");
  }
}

/** dns.lookup that refuses addresses Core must not connect to. */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, [] as dns.LookupAddress[]);
    const list = addresses as dns.LookupAddress[];
    if (!allowPrivate() && list.some((a) => isBlockedAddress(a.address))) {
      return callback(Object.assign(new Error(`storage endpoint ${hostname} resolves to an address that is not allowed`), { code: "EACCES" }), [] as dns.LookupAddress[]);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/** The S3 client's HTTP handler for user storage: every connection guarded. */
export function guardedRequestHandler(): NodeHttpHandler {
  return new NodeHttpHandler({
    httpsAgent: new https.Agent({ lookup: guardedLookup as unknown as net.LookupFunction, keepAlive: true }),
    httpAgent: new http.Agent({ lookup: guardedLookup as unknown as net.LookupFunction, keepAlive: true }),
    connectionTimeout: 10_000,
    requestTimeout: 120_000,
  });
}
