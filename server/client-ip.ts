import net from "net";
import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";

// The caller's IP address. Vox runs behind Cloudflare (cloudflared on the
// server, possibly Coolify's Traefik as well). How many proxies sit in front of
// it depends on the deployment, and Express's `trust proxy` hop count can't
// know that: with one hop too few, req.ip is a proxy's address for EVERY caller
// — every per-IP rate limit becomes one shared bucket, and GeoIP region
// detection sees the server's network, not the agent's.
//
// CF-Connecting-IP is Cloudflare's: set on every request it forwards,
// overwriting any value a client sends. It counts only when the request really
// came from Cloudflare — anyone can send the header to a server they reach
// directly. By who opened the connection to Vox:
//  - a PUBLIC peer: in Cloudflare's published ranges → CF-Connecting-IP (Vox
//    exposed behind Cloudflare's proxy); otherwise that peer IS the caller, and
//    no forwarded header counts (`trust proxy` alone would believe a
//    client-sent X-Forwarded-For on a directly exposed server).
//  - a PRIVATE-network peer (cloudflared, Traefik, any proxy on the server's
//    network): a proxy, and req.ip (via `trust proxy`) is the address it saw.
//    If that is Cloudflare — a private hop (cloudflared) or Cloudflare's ranges
//    — the client is CF-Connecting-IP. Anything else (a caller reaching
//    Traefik directly, CF header or not) is identified by that address.

/** Loopback, private (RFC 1918 / unique-local), link-local and CGNAT addresses. */
export function isPrivateAddress(raw: string | undefined): boolean {
  if (!raw) return false;
  const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || /^fe[89ab]/.test(lower);
  }
  return false;
}

// https://www.cloudflare.com/ips/ (they change rarely; a missing new range only
// means those requests fall back to the proxy's address, never a spoof).
const CLOUDFLARE_RANGES = new net.BlockList();
for (const r of ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"]) {
  const [a, n] = r.split("/"); CLOUDFLARE_RANGES.addSubnet(a, Number(n), "ipv4");
}
for (const r of ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32"]) {
  const [a, n] = r.split("/"); CLOUDFLARE_RANGES.addSubnet(a, Number(n), "ipv6");
}

const unmap = (ip: string) => (ip.startsWith("::ffff:") ? ip.slice(7) : ip);

export function isCloudflareAddress(raw: string | undefined): boolean {
  if (!raw) return false;
  const ip = unmap(raw);
  const family = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null;
  return family !== null && CLOUDFLARE_RANGES.check(ip, family);
}

function cfConnectingIp(req: Pick<Request, "headers">): string | undefined {
  const cf = req.headers["cf-connecting-ip"];
  const value = typeof cf === "string" ? cf.trim() : undefined;
  return value && net.isIP(value) ? value : undefined;
}

export function clientIp(req: Pick<Request, "ip" | "headers" | "socket">): string | undefined {
  const peer = req.socket?.remoteAddress;
  // No socket address (shouldn't happen on a live request): what Express derived.
  if (!peer) return req.ip;
  if (!isPrivateAddress(peer)) {
    // Straight from Cloudflare's edge: its header names the client.
    if (isCloudflareAddress(peer)) return cfConnectingIp(req) ?? unmap(peer);
    // No proxy in front: the peer is the caller, and no forwarded header counts.
    return unmap(peer);
  }
  // Through a local proxy: believe Cloudflare's header only if what the proxy
  // saw was Cloudflare — a private hop (cloudflared) or Cloudflare's edge.
  const seen = req.ip ? unmap(req.ip) : undefined;
  if (seen && !isPrivateAddress(seen) && !isCloudflareAddress(seen)) return seen;
  return cfConnectingIp(req) ?? seen;
}

/** Rate-limit key for the caller's address (IPv6 grouped by /56, as the library recommends). */
export function clientIpKey(req: Request): string {
  return ipKeyGenerator(clientIp(req) ?? "unknown");
}
