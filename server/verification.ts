import crypto from "node:crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import type { Express, Request, RequestHandler } from "express";
import type { NotificationsService, VerificationProof, VerificationService } from "@vox/plugin-sdk";
import { getInitCode, requireAuth, verifyPassword } from "./auth";
import { decryptValue, encryptValue, isEncryptionConfigured, pool, storage } from "./storage";
import rateLimit from "express-rate-limit";

let notifications: NotificationsService | null = null;
export function setVerificationNotifications(service: NotificationsService | null): void { notifications = service; }

export function canonicalPayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalPayload(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function payloadHash(payload: unknown): string { return crypto.createHash("sha256").update(canonicalPayload(payload)).digest("hex"); }
function secretHash(value: string): string {
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!key) throw new Error("Verification encryption is not configured");
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
}
export function authenticator(secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ issuer: "Vox", algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}
export class VerificationError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}
function reject(message: string, status = 403): never { throw new VerificationError(message, status); }
const ACTIONS = new Set(["credits.grant", "payments.pricing"]);

async function actor(req: Request, admin = false) {
  const user = req.session?.userId ? await storage.getUser(req.session.userId) : undefined;
  if (!user?.isEnabled || !req.sessionID) reject("Authentication required", 401);
  if (admin && !user.isAdmin) reject("Admin access required");
  return user;
}

async function reauthenticate(req: Request): Promise<void> {
  const user = await actor(req);
  if (user.passwordHash) {
    if (typeof req.body?.password !== "string" || !await verifyPassword(req.body.password, user.passwordHash)) reject("Current password required");
  } else if (user.isAdmin && (typeof req.body?.initCode !== "string" || !safeEqual(req.body.initCode, getInitCode()))) {
    reject("Initialization code required for admin authenticator setup");
  }
}

export const verificationService: VerificationService = {
  async consume(req, action, payload, proof: VerificationProof) {
    const user = await actor(req, true);
    if (!proof || typeof proof.initCode !== "string" || !safeEqual(proof.initCode, getInitCode())) reject("Invalid initialization code");
    if (typeof proof.challengeId !== "string" || typeof proof.code !== "string" || proof.code.length > 100) reject("Fresh verification required");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
      const { rows: [budget] } = await client.query("SELECT COALESCE(sum(attempts),0)::int AS attempts FROM verification_challenges WHERE user_id=$1 AND created_at>now()-interval '15 minutes'", [user.id]);
      if (budget.attempts >= 20) reject("Verification attempt limit reached; try again later", 429);
      const { rows: [challenge] } = await client.query(
        "SELECT * FROM verification_challenges WHERE id=$1 FOR UPDATE", [proof.challengeId]);
      if (!challenge || challenge.user_id !== user.id || challenge.session_hash !== secretHash(req.sessionID) ||
          challenge.action !== action || challenge.payload_hash !== payloadHash(payload) || challenge.consumed_at ||
          new Date(challenge.expires_at).getTime() <= Date.now() || challenge.attempts >= 5) reject("Verification expired, already used, or does not match this change");
      await client.query("UPDATE verification_challenges SET attempts=attempts+1 WHERE id=$1", [challenge.id]);
      let valid = false;
      if (challenge.method === "email") {
        valid = !!challenge.code_hash && safeEqual(challenge.code_hash, secretHash(`${challenge.id}:${proof.code}`));
      } else {
        const { rows: [factor] } = await client.query("SELECT * FROM user_verification_factors WHERE user_id=$1 FOR UPDATE", [user.id]);
        if (factor?.enabled && /^\d{6}$/.test(proof.code)) {
          const delta = authenticator(decryptValue(factor.encrypted_secret)).validate({ token: proof.code, window: 1 });
          const step = Math.floor(Date.now() / 30_000) + (delta ?? 0);
          valid = delta !== null && step > Number(factor.last_step);
          if (valid) await client.query("UPDATE user_verification_factors SET last_step=$2 WHERE user_id=$1", [user.id, step]);
        }
      }
      if (!valid) {
        // Failed attempts must commit too; rolling them back defeats the limit.
        await client.query("COMMIT");
        reject("Invalid or already used verification code");
      }
      await client.query("UPDATE verification_challenges SET consumed_at=now(), code_hash=NULL WHERE id=$1", [challenge.id]);
      const receipt = crypto.randomUUID();
      await client.query("INSERT INTO security_audit(id,user_id,action,payload_hash,method) VALUES($1,$2,$3,$4,$5)",
        [receipt, user.id, action, challenge.payload_hash, challenge.method]);
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  },
};

const route = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch((error) => {
    res.status(error instanceof VerificationError ? error.status : 500).json({ error: error instanceof VerificationError ? error.message : "Security operation failed" });
  });
};

export function registerVerificationRoutes(app: Express): void {
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, skip: (req) => req.method === "GET" });
  app.use("/api/user/security", requireAuth, limiter);
  app.use("/api/user/verification", requireAuth, limiter);
  app.get("/api/user/security", route(async (req, res) => {
    const user = await actor(req);
    const { rows: [factor] } = await pool.query("SELECT enabled FROM user_verification_factors WHERE user_id=$1", [user.id]);
    res.json({ totpEnabled: !!factor?.enabled, emailAvailable: !!notifications?.canSendEmail(), encryptionConfigured: isEncryptionConfigured(), hasPassword: !!user.passwordHash });
  }));
  app.post("/api/user/security/totp/enroll", route(async (req, res) => {
    await reauthenticate(req);
    if (!isEncryptionConfigured()) reject("Server encryption must be configured first", 503);
    const user = await actor(req);
    const totp = new OTPAuth.TOTP({ issuer: "Vox", label: user.email, algorithm: "SHA1", digits: 6, period: 30 });
    const result = await pool.query(
      `INSERT INTO user_verification_factors(user_id,encrypted_secret) VALUES($1,$2)
       ON CONFLICT(user_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret,created_at=now()
       WHERE NOT user_verification_factors.enabled RETURNING user_id`, [user.id, encryptValue(totp.secret.base32)]);
    if (!result.rowCount) reject("Authenticator already enabled; use a recovery code to reset it", 409);
    res.json({ qrCode: await QRCode.toDataURL(totp.toString()), secret: totp.secret.base32 });
  }));
  app.post("/api/user/security/totp/confirm", route(async (req, res) => {
    const user = await actor(req);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [factor] } = await client.query("SELECT * FROM user_verification_factors WHERE user_id=$1 FOR UPDATE", [user.id]);
      if (!factor || factor.enabled || new Date(factor.created_at).getTime() + 10 * 60_000 < Date.now()) reject("Start authenticator setup again");
      const delta = typeof req.body?.code === "string" && /^\d{6}$/.test(req.body.code) ? authenticator(decryptValue(factor.encrypted_secret)).validate({ token: req.body.code, window: 1 }) : null;
      if (delta === null) reject("Invalid authenticator code");
      const recoveryCodes = Array.from({ length: 8 }, () => crypto.randomBytes(12).toString("hex"));
      await client.query("UPDATE user_verification_factors SET enabled=true,last_step=$2,recovery_hashes=$3 WHERE user_id=$1",
        [user.id, Math.floor(Date.now() / 30_000) + delta, JSON.stringify(recoveryCodes.map((code) => secretHash(`${user.id}:${code}`)))]);
      await client.query("COMMIT");
      res.json({ recoveryCodes });
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }));
  app.post("/api/user/security/totp/recover", route(async (req, res) => {
    await reauthenticate(req);
    const user = await actor(req);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [factor] } = await client.query("SELECT * FROM user_verification_factors WHERE user_id=$1 FOR UPDATE", [user.id]);
      const hashes: string[] = factor?.recovery_hashes ?? [];
      if (!factor?.enabled || typeof req.body?.recoveryCode !== "string" || !hashes.some((hash) => safeEqual(hash, secretHash(`${user.id}:${req.body.recoveryCode.trim()}`)))) reject("Invalid recovery code");
      await client.query("DELETE FROM user_verification_factors WHERE user_id=$1", [user.id]);
      await client.query("UPDATE verification_challenges SET consumed_at=now(),code_hash=NULL WHERE user_id=$1 AND consumed_at IS NULL", [user.id]);
      await client.query("INSERT INTO security_audit(id,user_id,action,payload_hash,method) VALUES($1,$2,'security.totp.recover',$3,'recovery')", [crypto.randomUUID(), user.id, payloadHash({})]);
      await client.query("COMMIT");
      res.json({ reset: true });
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }));
  app.post("/api/user/verification/challenges", route(async (req, res) => {
    const user = await actor(req, true);
    const { action, payload, method } = req.body ?? {};
    if (!ACTIONS.has(action) || !["totp", "email"].includes(method) || canonicalPayload(payload).length > 64_000) reject("Invalid verification request", 400);
    if (!isEncryptionConfigured()) reject("Server encryption must be configured first", 503);
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const code = method === "email" ? crypto.randomInt(0, 1_000_000).toString().padStart(6, "0") : null;
    if (method === "totp") {
      const { rows: [factor] } = await pool.query("SELECT enabled FROM user_verification_factors WHERE user_id=$1", [user.id]);
      if (!factor?.enabled) reject("Set up Google Authenticator in Settings first", 409);
    } else if (!notifications?.canSendEmail()) reject("Email notifications are not configured", 503);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
      const recent = method === "email" ? await client.query("SELECT 1 FROM verification_challenges WHERE user_id=$1 AND method='email' AND created_at>now()-interval '60 seconds'", [user.id]) : null;
      if (recent?.rowCount) reject("Wait 60 seconds before requesting another email code", 429);
      await client.query("INSERT INTO verification_challenges(id,user_id,session_hash,action,payload_hash,method,code_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, user.id, secretHash(req.sessionID), action, payloadHash(payload), method, code ? secretHash(`${id}:${code}`) : null, expiresAt]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    if (code) {
      try {
        await notifications!.sendEmail({ to: user.email, subject: "Vox: confirm your admin change", text: `Your verification code is ${code}. It expires in five minutes.\nAction: ${action}\nChange fingerprint: ${payloadHash(payload).slice(0, 16)}\nIf you did not request this, do not share this code.`, idempotencyKey: id, expiresAt });
      } catch {
        await pool.query("UPDATE verification_challenges SET consumed_at=now(),code_hash=NULL WHERE id=$1", [id]);
        reject("Verification email could not be delivered; try again later", 503);
      }
    }
    res.status(201).json({ challengeId: id, expiresAt: expiresAt.toISOString() });
  }));
}
