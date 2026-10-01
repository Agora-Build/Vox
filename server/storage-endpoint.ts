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

// net.BlockList parses addresses properly and matches IPv4-mapped IPv6
// (::ffff:7f00:1 as well as ::ffff:127.0.0.1) against the IPv4 rules — a
// hand-written string match missed the hex form.
const blocked = new net.BlockList();
for (const [base, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) blocked.addSubnet(base, bits, "ipv4");
for (const [base, bits] of [
  ["::", 96],        // unspecified, loopback, and IPv4-compatible ::a.b.c.d
  ["64:ff9b::", 96], // NAT64: reaches IPv4, internal addresses included
  ["fe80::", 10],    // link-local
  ["fc00::", 7],     // unique local
  ["ff00::", 8],     // multicast
  ["2002::", 16],    // 6to4: embeds an IPv4 address, internal ones included
  ["2001::", 32],    // Teredo: likewise
] as const) blocked.addSubnet(base, bits, "ipv6");

/** Whether Core must not connect to this address. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return blocked.check(ip, "ipv4");
  if (net.isIPv6(ip)) return blocked.check(ip, "ipv6");
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
    // No keep-alive: each operation builds its own client, so pooled sockets
    // would never be reused — only leaked.
    httpsAgent: new https.Agent({ lookup: guardedLookup as unknown as net.LookupFunction, keepAlive: false }),
    httpAgent: new http.Agent({ lookup: guardedLookup as unknown as net.LookupFunction, keepAlive: false }),
    connectionTimeout: 10_000,
    requestTimeout: 120_000,
  });
}
