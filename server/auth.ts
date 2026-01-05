import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import session from "express-session";
import { storage } from "./storage";
import type { User } from "@shared/schema";

declare module "express-session" {
  interface SessionData {
    userId: string;
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

export async function getCurrentUser(req: Request): Promise<User | undefined> {
  if (!req.session?.userId) {
    return undefined;
  }
  return storage.getUser(req.session.userId);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const user = await storage.getUser(req.session.userId);
  if (!user || !user.isAdmin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

export async function requirePrincipal(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const user = await storage.getUser(req.session.userId);
  if (!user || user.plan !== "principal") {
    return res.status(403).json({ error: "Principal access required" });
  }
  next();
}

export async function requireEnabled(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const user = await storage.getUser(req.session.userId);
  if (!user || !user.isEnabled) {
    return res.status(403).json({ error: "Account is disabled" });
  }
  next();
}
