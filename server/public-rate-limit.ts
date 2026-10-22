import rateLimit from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import { clientIpKey } from "./client-ip";

// Per-IP rate limit for the public v1 API's keyless requests (the metrics
// endpoints and other endpoints that need no key). A request that carries an
// API key — or a signed-in session — is not counted here: it is identified, and
// stays under the general per-IP /api limit only. Mounted AFTER
// authenticateApiKey (server/index.ts), which is what sets req.apiKeyUser.

export const DEFAULT_KEYLESS_PER_MINUTE = 12;

/** Paths under /api/v1 never limited here (the docs page must always load). */
const EXEMPT = new Set(["/openapi.json"]);

export function keylessPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PUBLIC_API_RATE_LIMIT_PER_MINUTE);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_KEYLESS_PER_MINUTE;
}

const identified = (req: Request) =>
  !!(req as { apiKeyUser?: unknown }).apiKeyUser || !!(req as { session?: { userId?: unknown } }).session?.userId;

export function createKeylessLimiter(opts: { enabled: boolean; perMinute: number }): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: opts.perMinute,
    standardHeaders: "draft-7", // RateLimit + Retry-After
    legacyHeaders: false,
    // Per client IP — the real caller behind Cloudflare/Traefik, not a proxy
    // (server/client-ip.ts); IPv6 grouped by /56.
    keyGenerator: clientIpKey,
    skip: (req) => !opts.enabled || identified(req) || EXEMPT.has(req.path),
    message: {
      error: `Too many requests without an API key: up to ${opts.perMinute} per minute per IP. ` +
        "Send an API key (Authorization: Bearer vox_live_...) for higher limits — create one at /console/api-keys.",
    },
  });
}
