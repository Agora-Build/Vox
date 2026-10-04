import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { NotificationsService, SecretEncryptionService, VoxPluginContext } from "@vox/plugin-sdk";
import { discordDestination } from "../configuration";

export interface Message {
  kind: "email" | "discord";
  subject: string; text: string; to?: string; webhookUrl?: string;
  automation?: { ruleId: string; revision: string; channelId: string; channelRevision: string; subjectId: number };
}
export function createDelivery(ctx: VoxPluginContext, encryption: SecretEncryptionService, eligible: (message: Message) => Promise<boolean>) {
  const host = ctx.config.get("SMTP_HOST");
  const from = ctx.config.get("NOTIFICATIONS_FROM");
  const transport = host && from ? nodemailer.createTransport({
    host, port: Number(ctx.config.get("SMTP_PORT") ?? 587), secure: ctx.config.get("SMTP_SECURE") === "true",
    requireTLS: ctx.config.get("SMTP_REQUIRE_TLS") !== "false",
    auth: ctx.config.get("SMTP_USER") ? { user: ctx.config.get("SMTP_USER"), pass: ctx.config.get("SMTP_PASSWORD") } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  }) : null;
  let busy = false;
  const deliver = async (key?: string) => {
    if (busy) return false;
    busy = true;
    try {
      await ctx.db.query("UPDATE deliveries SET status='expired',payload_ciphertext=NULL,lease_token=NULL,lease_until=NULL WHERE status IN ('pending','sending') AND expires_at<=now()");
      if (!encryption.configured()) return false;
      const token = randomUUID();
      const { rows: [job] } = await ctx.db.query<{ id: string; payload_ciphertext: string; attempts: number; expires_at: Date }>(
        `WITH candidate AS (SELECT id FROM deliveries WHERE ((status='pending' AND next_attempt_at<=now()) OR (status='sending' AND lease_until<=now()))
          AND expires_at>now() ${key ? "AND idempotency_key=$2" : ""} ORDER BY CASE WHEN rule_id IS NULL THEN 0 ELSE 1 END,id LIMIT 1 FOR UPDATE SKIP LOCKED)
         UPDATE deliveries SET status='sending',lease_token=$1,lease_until=now()+interval '60 seconds'
         FROM candidate WHERE deliveries.id=candidate.id RETURNING deliveries.id,payload_ciphertext,attempts,expires_at`, key ? [token, key] : [token]);
      if (!job) return false;
      try {
        const message = JSON.parse(encryption.decrypt(job.payload_ciphertext)) as Message;
        message.kind ??= "email"; // Retained v1 security-code deliveries.
        if (new Date(job.expires_at).getTime() <= Date.now() || !await eligible(message)) {
          await ctx.db.query("UPDATE deliveries SET status='expired',payload_ciphertext=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2", [job.id, token]);
          return true;
        }
        if (message.kind === "email") {
          if (!transport) throw new Error("Email transport unavailable");
          await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text });
        } else if (message.kind === "discord") {
          const response = await fetch(discordDestination(message.webhookUrl ?? ""), {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: `${message.subject}\n${message.text}`.slice(0, 2000), allowed_mentions: { parse: [] } }),
          });
          if (!response.ok) throw new Error("Discord delivery failed");
        } else throw new Error("Unsupported notification channel");
        await ctx.db.query("UPDATE deliveries SET status='delivered',attempts=attempts+1,delivered_at=now(),payload_ciphertext=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2", [job.id, token]);
      } catch {
        const status = job.attempts + 1 >= 5 ? "failed" : "pending";
        await ctx.db.query("UPDATE deliveries SET attempts=attempts+1,status=$3,payload_ciphertext=CASE WHEN $3='failed' THEN NULL ELSE payload_ciphertext END,next_attempt_at=now()+($4 * interval '1 second'),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",
          [job.id, token, status, Math.min(300, 5 * 2 ** job.attempts)]);
        ctx.logger.warn("Notification delivery will retry or has exhausted retries", { deliveryId: job.id });
      }
      return true;
    } finally { busy = false; }
  };
  const service: NotificationsService = {
    canSendEmail: () => !!transport && encryption.configured(),
    async sendEmail(input) {
      if (!service.canSendEmail()) throw new Error("Email notifications are unavailable");
      const message: Message = { kind: "email", to: input.to, subject: input.subject, text: input.text };
      await ctx.db.query("INSERT INTO deliveries(idempotency_key,payload_ciphertext,expires_at) VALUES($1,$2,$3) ON CONFLICT(idempotency_key) DO NOTHING",
        [input.idempotencyKey, encryption.encrypt(JSON.stringify(message)), input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60_000)]);
      // A successful return means durably queued, not necessarily delivered.
      await deliver(input.idempotencyKey);
    },
  };
  return { service, deliver, emailAvailable: service.canSendEmail };
}
