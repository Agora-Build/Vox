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
// Two cases, by who opened the connection to Vox:
//  - a PRIVATE-network peer (cloudflared, Traefik, any proxy on the server's
//    network): a proxy. The client is Cloudflare's CF-Connecting-IP — set on
//    every request, overwriting any value a client sends, so it can't be forged
//    through Cloudflare — or, without it, the address the proxy forwarded
//    (req.ip, via `trust proxy`).
//  - a PUBLIC peer: there's no proxy in front — that peer IS the caller. Its
//    socket address is used and every forwarded header ignored, so a caller
//    can't pick its own identity with CF-Connecting-IP or X-Forwarded-For
//    (`trust proxy` alone would believe a client-sent X-Forwarded-For on a
//    directly exposed server).

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

export function clientIp(req: Pick<Request, "ip" | "headers" | "socket">): string | undefined {
  const peer = req.socket?.remoteAddress;
  // No socket address (shouldn't happen on a live request): what Express derived.
  if (!peer) return req.ip;
  // A public peer is the caller itself: no proxy, so no forwarded header counts.
  if (!isPrivateAddress(peer)) return peer.startsWith("::ffff:") ? peer.slice(7) : peer;
  const cf = req.headers["cf-connecting-ip"];
  const value = typeof cf === "string" ? cf.trim() : undefined;
  if (value && net.isIP(value)) return value;
  return req.ip;
}

/** Rate-limit key for the caller's address (IPv6 grouped by /56, as the library recommends). */
export function clientIpKey(req: Request): string {
  return ipKeyGenerator(clientIp(req) ?? "unknown");
}
