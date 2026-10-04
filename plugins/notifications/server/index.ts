import nodemailer from "nodemailer";
import type { VoxPlugin, NotificationsService, SecretEncryptionService } from "@vox/plugin-sdk";

const plugin: VoxPlugin = {
  async activate(ctx) {
    const encryption = ctx.services.require<SecretEncryptionService>("vox.encryption", "^1.0.0");
    const host = ctx.config.get("SMTP_HOST");
    const from = ctx.config.get("NOTIFICATIONS_FROM");
    const transport = host && from ? nodemailer.createTransport({
      host,
      port: Number(ctx.config.get("SMTP_PORT") ?? 587),
      secure: ctx.config.get("SMTP_SECURE") === "true",
      requireTLS: ctx.config.get("SMTP_REQUIRE_TLS") !== "false",
      auth: ctx.config.get("SMTP_USER") ? { user: ctx.config.get("SMTP_USER"), pass: ctx.config.get("SMTP_PASSWORD") } : undefined,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    }) : null;
    const deliver = async () => {
      await ctx.db.query("UPDATE deliveries SET status='expired',payload_ciphertext=NULL WHERE status='pending' AND expires_at<=now()");
      if (!transport || !encryption.configured()) return;
      // Keep the row lock through delivery: workers cannot concurrently send a row.
      await ctx.db.withTransaction(async (tx) => {
        await tx.query("UPDATE deliveries SET status='expired',payload_ciphertext=NULL WHERE status='pending' AND expires_at<=now()");
        const { rows: [job] } = await tx.query<{ id: string; payload_ciphertext: string; attempts: number }>(
          "SELECT id,payload_ciphertext,attempts FROM deliveries WHERE status='pending' AND next_attempt_at<=now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
        if (!job) return;
        try {
          const message = JSON.parse(encryption.decrypt(job.payload_ciphertext));
          await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text });
          await tx.query("UPDATE deliveries SET status='delivered',attempts=attempts+1,delivered_at=now(),payload_ciphertext=NULL WHERE id=$1", [job.id]);
        } catch {
          const exhausted = job.attempts + 1 >= 5;
          await tx.query("UPDATE deliveries SET attempts=attempts+1,status=$2,payload_ciphertext=CASE WHEN $2='failed' THEN NULL ELSE payload_ciphertext END,next_attempt_at=now()+($3 * interval '1 second') WHERE id=$1",
            [job.id, exhausted ? "failed" : "pending", Math.min(60, 5 * 2 ** job.attempts)]);
          ctx.logger.warn("Email delivery will retry or has exhausted retries", { deliveryId: job.id });
        }
      });
    };
    const service: NotificationsService = {
      canSendEmail: () => !!transport && encryption.configured(),
      async sendEmail(input) {
        if (!service.canSendEmail()) throw new Error("Email notifications are unavailable");
        await ctx.db.query("INSERT INTO deliveries(idempotency_key,payload_ciphertext,expires_at) VALUES($1,$2,$3) ON CONFLICT(idempotency_key) DO NOTHING",
          [input.idempotencyKey, encryption.encrypt(JSON.stringify({ to: input.to, subject: input.subject, text: input.text })), input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60_000)]);
        await deliver();
      },
    };
    ctx.worker({ id: "delivery", intervalMs: 5000, singleton: true, run: deliver });
    ctx.provideService("vox.notifications", "1.0.0", service);
    ctx.health(async () => { await ctx.db.query("SELECT 1"); return { status: "ok", detail: service.canSendEmail() ? "Email configured" : "Email unavailable; configure SMTP and encryption" }; });
  },
};
export default plugin;
