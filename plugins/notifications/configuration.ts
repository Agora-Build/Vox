import { z } from "zod";

export const METRICS = ["credits.available", "jobs.failed24h", "jobs.completed24h", "jobs.running", "eval.responseLatencyMs", "eval.turnSuccessRate"] as const;
export const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: z.number().int().positive().max(2147483647) }).strict(),
  z.object({ type: z.literal("group"), groupId: z.string().uuid() }).strict(),
]);
export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("compare"), metric: z.enum(METRICS), operator: z.enum(["<", "<=", "=", "!=", ">=", ">"]), value: z.number().finite() }).strict(),
  z.object({ type: z.literal("javascript"), code: z.string().trim().min(1).max(8192) }).strict(),
  z.object({ type: z.literal("llm"), prompt: z.string().trim().min(10).max(2000) }).strict(),
]);
export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  audience: audienceSchema,
  condition: conditionSchema,
  channelIds: z.array(z.string().uuid()).min(1).max(5).transform((ids) => Array.from(new Set(ids))),
  subject: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(1500),
  intervalSeconds: z.number().int().min(60).max(86400).default(300),
  cooldownSeconds: z.number().int().min(300).max(604800).default(3600),
  enabled: z.boolean().default(false),
}).strict().superRefine((rule, ctx) => {
  if (rule.condition.type === "llm" && rule.intervalSeconds < 900) ctx.addIssue({ code: "custom", message: "LLM rules require at least a 15-minute interval", path: ["intervalSeconds"] });
});
export const channelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["email", "discord"]),
  groupId: z.string().uuid().nullable().default(null),
  webhookUrl: z.string().max(300).optional(),
  enabled: z.boolean().default(true),
}).strict();
export const groupSchema = z.object({ name: z.string().trim().min(1).max(80), userIds: z.array(z.number().int().positive().max(2147483647)).min(1).max(100).transform((ids) => Array.from(new Set(ids)).sort((a, b) => a - b)) }).strict();
export const permissionSchema = z.object({
  userId: z.number().int().positive().max(2147483647),
  canEdit: z.boolean(), canScript: z.boolean(), canLlm: z.boolean(),
  groupIds: z.array(z.string().uuid()).max(50).transform((ids) => Array.from(new Set(ids))),
}).strict();
export const evaluationSchema = z.object({ matched: z.boolean(), summary: z.string().max(300).default("") }).strict();
export type RuleDefinition = z.infer<typeof ruleSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;
export interface Snapshot {
  metrics: Record<string, number | null>;
  samples: Array<{ id: number; at: string; values: Record<string, number | null> }>;
}
export interface Permission { canEdit: boolean; canScript: boolean; canLlm: boolean; groupIds: string[]; isAdmin: boolean; }
export interface Channel { id: string; owner_ref: number; group_id: string | null; name: string; kind: "email" | "discord"; destination_ciphertext: string | null; enabled: boolean; revision: string; }
export interface Rule { id: string; editor_ref: number; definition: RuleDefinition; revision: string; enabled: boolean; }
export class NotificationError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function fail(message: string, status = 400): never { throw new NotificationError(message, status); }

export function discordDestination(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { return fail("Invalid Discord webhook URL"); }
  if (url.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !/^\/api\/webhooks\/\d{17,21}\/[A-Za-z0-9_-]{40,150}$/.test(url.pathname)) fail("Use an official HTTPS Discord webhook URL");
  return url.toString();
}
export function compare(left: number | null | undefined, operator: string, right: number): boolean {
  if (left == null || !Number.isFinite(left)) return false;
  switch (operator) {
    case "<": return left < right;
    case "<=": return left <= right;
    case "=": return left === right;
    case "!=": return left !== right;
    case ">=": return left >= right;
    case ">": return left > right;
    default: return false;
  }
}
export function render(template: string, values: Record<string, string | number | null>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, key: string) => values[key] == null ? "N/A" : String(values[key]));
}
