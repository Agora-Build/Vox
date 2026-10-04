import type { PersonalEntitlementsService, UserDirectoryService } from "@vox/plugin-sdk";
import { pool, storage } from "./storage";

export const userDirectoryService: UserDirectoryService = {
  async getUsers(ids) {
    const rows = await storage.getUsersByIds(ids);
    return rows.map((u) => ({ id: u.id, username: u.username, email: u.email, isAdmin: u.isAdmin, isEnabled: u.isEnabled, emailVerified: !!u.emailVerifiedAt, hasPassword: !!u.passwordHash }));
  },
  async listIds(afterId, limit) {
    const { rows } = await pool.query("SELECT id FROM users WHERE id>$1 ORDER BY id LIMIT $2", [afterId, Math.min(limit, 500)]);
    return rows.map((row) => row.id as number);
  },
};

export const personalEntitlementsService: PersonalEntitlementsService = {
  async setPremium(userId, sourceRef, expiresAt) {
    if (expiresAt === null) {
      await pool.query("DELETE FROM personal_entitlements WHERE user_id=$1 AND source_ref=$2", [userId, sourceRef]);
    } else {
      await pool.query(`INSERT INTO personal_entitlements(user_id,source_ref,expires_at) VALUES($1,$2,$3)
        ON CONFLICT(user_id,source_ref) DO UPDATE SET expires_at=EXCLUDED.expires_at`, [userId, sourceRef, expiresAt]);
    }
  },
};
