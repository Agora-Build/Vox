import crypto from "crypto";
import type { IdentityService, IdentityUser } from "@vox/plugin-sdk";
import { sql } from "drizzle-orm";
import { users, type User } from "@shared/schema";
import { db, storage } from "./storage";

// Core's implementation of `vox.identity@1.0.0` — the only way a plugin reaches
// Core users and sessions. Registered with the plugin loader before plugins
// activate (server/index.ts).

function toIdentityUser(u: User): IdentityUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    isAdmin: u.isAdmin,
    isEnabled: u.isEnabled,
    emailVerified: !!u.emailVerifiedAt,
    hasPassword: !!u.passwordHash,
  };
}

// username is UNIQUE, so a collision is resolved before insert: the preferred
// name as-is, then with a numeric suffix, then a random one.
async function uniqueUsername(preferred: string | undefined, email: string): Promise<string> {
  const base = (preferred && preferred.trim()) || email.split("@")[0] || "user";
  if (!(await storage.getUserByUsername(base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}${i}`;
    if (!(await storage.getUserByUsername(candidate))) return candidate;
  }
  return `${base}_${crypto.randomBytes(4).toString("hex")}`;
}

export const identityService: IdentityService = {
  async getUserById(id) {
    const u = await storage.getUser(id);
    return u ? toIdentityUser(u) : null;
  },

  // Case-insensitive: providers do not preserve the case a user signed up
  // with, and an exact match would hand Alice@Example.com a second account
  // (or a unique-email error) next to alice@example.com. If two accounts
  // differ only by case, the exact match wins, then the oldest.
  async getUserByEmail(email) {
    const rows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .orderBy(sql`(${users.email} = ${email}) DESC`, users.id)
      .limit(1);
    return rows[0] ? toIdentityUser(rows[0]) : null;
  },

  async createUser({ email, preferredUsername }) {
    const u = await storage.createUser({
      username: await uniqueUsername(preferredUsername, email),
      email,
      passwordHash: null,
      plan: "basic",
      isAdmin: false,
      isEnabled: true,
      emailVerifiedAt: new Date(),
    });
    return toIdentityUser(u);
  },

  async markEmailVerified(userId) {
    const u = await storage.getUser(userId);
    if (u && !u.emailVerifiedAt) await storage.updateUser(userId, { emailVerifiedAt: new Date() });
  },

  signIn(req, userId) {
    // Regenerate, then set and save before responding: same shape as password
    // login, and it stops a pre-sign-in session id (session fixation) from
    // becoming a signed-in one.
    return new Promise<void>((resolve, reject) => {
      req.session.regenerate((regenErr) => {
        if (regenErr) return reject(regenErr);
        req.session.userId = userId;
        req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
      });
    });
  },

  signOut(req) {
    delete req.session.userId;
  },
};
