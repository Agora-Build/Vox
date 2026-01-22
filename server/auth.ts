import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy, Profile } from "passport-google-oauth20";
import { storage, hashToken } from "./storage";
import type { User as SchemaUser } from "@shared/schema";

// Re-export for convenience
export type User = SchemaUser;

declare module "express-session" {
  interface SessionData {
    userId: number;
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
  if (!user || (user.plan !== "principal" && user.plan !== "fellow")) {
    return res.status(403).json({ error: "Principal or Fellow access required" });
  }
  next();
}

export async function requireOrgAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const user = await storage.getUser(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: "User not found" });
  }
  if (!user.organizationId) {
    return res.status(403).json({ error: "Organization membership required" });
  }
  if (!user.isOrgAdmin) {
    return res.status(403).json({ error: "Organization admin access required" });
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

  if (!apiKey) {
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

  req.apiKeyUser = user;
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

export async function getCurrentUserOrApiKeyUser(req: Request): Promise<User | undefined> {
  if (req.apiKeyUser) {
    return req.apiKeyUser;
  }

  if (req.session?.userId) {
    return storage.getUser(req.session.userId);
  }

  return undefined;
}

// ==================== GOOGLE OAUTH ====================

export { passport };

// Configure passport serialization
passport.serializeUser((user: Express.User, done) => {
  done(null, (user as User).id);
});

passport.deserializeUser(async (id: number, done) => {
  try {
    const user = await storage.getUser(id);
    done(null, user || null);
  } catch (error) {
    done(error, null);
  }
});

// Initialize Google OAuth strategy if credentials are provided
export function initializeGoogleOAuth(): boolean {
  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const callbackURL = process.env.GOOGLE_CALLBACK_URL || "/api/auth/google/callback";

  if (!clientID || !clientSecret) {
    console.warn("Google OAuth not configured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET required");
    return false;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID,
        clientSecret,
        callbackURL,
        scope: ["profile", "email"],
      },
      async (
        accessToken: string,
        refreshToken: string,
        profile: Profile,
        done: (error: Error | null, user?: User | false) => void
      ) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) {
            return done(new Error("No email found in Google profile"));
          }

          // Check if user already exists with this Google ID
          let user = await storage.getUserByGoogleId(profile.id);
          if (user) {
            if (!user.isEnabled) {
              return done(new Error("Account is disabled"));
            }
            return done(null, user);
          }

          // Check if user exists with this email
          user = await storage.getUserByEmail(email);
          if (user) {
            // Link Google account to existing user
            if (user.googleId && user.googleId !== profile.id) {
              return done(new Error("Email already linked to different Google account"));
            }
            if (!user.isEnabled) {
              return done(new Error("Account is disabled"));
            }
            // Link Google ID to existing account
            const updated = await storage.updateUser(user.id, {
              googleId: profile.id,
              emailVerifiedAt: user.emailVerifiedAt || new Date(),
            });
            return done(null, updated || user);
          }

          // Create new user with Google account
          const username = email.split("@")[0] + "_" + crypto.randomBytes(4).toString("hex");
          const newUser = await storage.createUser({
            username,
            email,
            passwordHash: null, // No password for OAuth users
            plan: "basic",
            isAdmin: false,
            isEnabled: true,
            emailVerifiedAt: new Date(),
            googleId: profile.id,
          });

          done(null, newUser);
        } catch (error) {
          done(error as Error);
        }
      }
    )
  );

  return true;
}
