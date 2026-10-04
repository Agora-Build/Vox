import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import session from "express-session";
import { storage, hashToken } from "./storage";
import type { User as SchemaUser } from "@shared/schema";
import { getOrganizations, type Membership } from "./organizations";

// Re-export for convenience
export type User = SchemaUser;

/**
 * The authenticated caller. The org columns are deliberately OMITTED: membership
 * is the only supported way to ask which org this person belongs to, so a future
 * plugin can own it. Reading the columns is a compile error by design.
 */
export type AuthUser = Omit<User, 'organizationId' | 'orgRole'> & { membership: Membership | null };

// Per-request memo: a single request may call getCurrentUser several times, and
// each call would otherwise hit the provider again. WeakMap keyed by the request
// avoids augmenting Express's type surface.
const membershipCache = new WeakMap<Request, Map<number, Membership | null>>();

/**
 * The ONE way to resolve a membership inside a request. Every seam call on the
 * request path goes through here so a single request sees a single answer for a
 * given user. That is not merely a round-trip saving: under a plugin-owned
 * provider, two independent lookups could disagree mid-request, and a guard
 * could then admit on one answer while the handler body rejects on the other.
 */
export async function membershipFor(req: Request, userId: number): Promise<Membership | null> {
  // Absent provider → orgs inert, fails closed to "no membership" WITHOUT
  // caching the answer (there's nothing to memoize — the next call re-checks
  // in case a provider gets installed later, e.g. across tests). A provider
  // that throws is a different case entirely and propagates below: failure
  // must stay distinguishable from "no org" for callers that decide on it.
  const orgs = getOrganizations();
  if (!orgs) return null;
  let perRequest = membershipCache.get(req);
  if (!perRequest) {
    perRequest = new Map();
    membershipCache.set(req, perRequest);
  }
  if (!perRequest.has(userId)) {
    perRequest.set(userId, await orgs.getMembership(userId));
  }
  return perRequest.get(userId) ?? null;
}

export async function resolveMembership(
  user: User | undefined,
  req: Request,
): Promise<AuthUser | undefined> {
  if (!user) return undefined;
  const membership = await membershipFor(req, user.id);
  const { organizationId: _organizationId, orgRole: _orgRole, ...rest } = user;
  return { ...rest, membership };
}

declare module "express-session" {
  interface SessionData {
    userId: number;
    oauthVerifiedAt?: number;
  }
}

// Extend Express types
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKeyUser?: SchemaUser;
      apiKeyId?: number;
    }
  }
}

export { session };

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function getInitCode(): string {
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging") {
    const code = process.env.INIT_CODE;
    if (!code) {
      throw new Error("INIT_CODE environment variable is required in production/staging");
    }
    return code;
  }
  return "VOX-DEBUG-2024";
}

export async function isSystemInitialized(): Promise<boolean> {
  const config = await storage.getConfig("system_initialized");
  return config?.value === "true";
}

export async function markSystemInitialized(): Promise<void> {
  await storage.setConfig({ key: "system_initialized", value: "true" });
}

export async function getCurrentUser(req: Request): Promise<AuthUser | undefined> {
  if (!req.session?.userId) {
    return undefined;
  }
  return resolveMembership(await storage.getUser(req.session.userId), req);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const user = await storage.getUser(req.session.userId);
  if (!user || !user.isEnabled) {
    return res.status(401).json({ error: "Account is disabled" });
  }
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = req.apiKeyUser ?? (req.session?.userId ? await storage.getUser(req.session.userId) : undefined);
  if (!user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  if (!user.isAdmin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

export async function requirePrincipal(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const user = await storage.getUser(req.session.userId);
  if (!user || (user.plan !== "principal" && user.plan !== "fellow")) {
    return res.status(403).json({ error: "Principal or Fellow access required" });
  }
  next();
}

export async function requireOrgAdmin(req: Request, res: Response, next: NextFunction) {
  // Feature-availability gate, checked first: an absent provider means the
  // orgs feature is off, full stop — no point reasoning about session/user
  // state underneath a feature that isn't there.
  if (!getOrganizations()) {
    return res.status(501).json({ error: "Organizations feature not enabled" });
  }
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const user = await storage.getUser(req.session.userId);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }
    // Same per-request memo the handler body's `user.membership` came from, so the
    // guard and the body can never decide on two different answers.
    const membership = await membershipFor(req, user.id);
    if (!membership) {
      return res.status(403).json({ error: "Organization membership required" });
    }
    if (membership.role !== 'owner' && membership.role !== 'admin') {
      return res.status(403).json({ error: "Organization admin access required" });
    }
    next();
  } catch {
    // Provider installed but failing: distinct from absence, and distinct
    // from "no org" — a 500 would hide that this is an org-service outage.
    res.status(503).json({ error: "Organizations service unavailable" });
  }
}

// ==================== API KEY AUTHENTICATION ====================

const API_KEY_PREFIX = "vox_live_";

export function generateApiKey(): { key: string; prefix: string } {
  const randomPart = crypto.randomBytes(24).toString("base64url");
  const key = `${API_KEY_PREFIX}${randomPart}`;
  const prefix = key.slice(0, 12);
  return { key, prefix };
}

export async function authenticateApiKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.slice(7);

  if (!token.startsWith(API_KEY_PREFIX)) {
    return next();
  }

  const keyHash = hashToken(token);
  const apiKey = await storage.getApiKeyByHash(keyHash);

  if (!apiKey || apiKey.isDeleted) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  if (apiKey.isRevoked) {
    return res.status(401).json({ error: "API key has been revoked" });
  }

  if (apiKey.expiresAt && new Date() > apiKey.expiresAt) {
    return res.status(401).json({ error: "API key has expired" });
  }

  const user = await storage.getUser(apiKey.createdBy);
  if (!user || !user.isEnabled) {
    return res.status(403).json({ error: "User account is disabled" });
  }

  await storage.incrementApiKeyUsage(apiKey.id);

  // An API key never carries admin rights, even an admin's own key: admin
  // powers (moderation, user and provider management, reading or cancelling
  // anyone's jobs) are for a person in the browser. Keys are long-lived bearer
  // secrets that end up in scripts, CI and chat logs; a leaked one must reach
  // no further than an ordinary account.
  req.apiKeyUser = { ...user, isAdmin: false };
  req.apiKeyId = apiKey.id;

  next();
}

export function requireAuthOrApiKey(req: Request, res: Response, next: NextFunction) {
  if (req.apiKeyUser) {
    return next();
  }

  if (req.session?.userId) {
    return next();
  }

  return res.status(401).json({ error: "Authentication required" });
}

export async function getCurrentUserOrApiKeyUser(req: Request): Promise<AuthUser | undefined> {
  if (req.apiKeyUser) {
    return resolveMembership(req.apiKeyUser, req);
  }

  if (req.session?.userId) {
    return resolveMembership(await storage.getUser(req.session.userId), req);
  }

  return undefined;
}
