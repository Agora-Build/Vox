import { createHash, randomUUID } from "node:crypto";
import type { NotificationDataService, SecretEncryptionService, VoxPluginContext } from "@vox/plugin-sdk";
import type { Access } from "./access";
import { createEvaluator } from "./evaluate";
import { fail, render, type Rule, type Snapshot, NotificationError } from "../configuration";
import type { Message } from "./delivery";

interface State { rule_id: string; subject_ref: number; last_matched: boolean; last_hash: string | null; last_fired_at: Date | null; lease_token: string; }
export function createAutomation(ctx: VoxPluginContext, encryption: SecretEncryptionService, access: Access) {
  const evaluator = createEvaluator(ctx.db, ctx.config);
  const data = ctx.services.optional<NotificationDataService>("vox.notification-data", "^1.0.0");
  const credits = ctx.services.optional<{ getBalance(userId: number): Promise<number> }>("vox.credits", "^1.0.0");
  const snapshot = async (userId: number): Promise<Snapshot> => {
    const result: Snapshot = data ? await data.getSnapshot(userId) : { metrics: {}, samples: [] };
    if (credits) result.metrics["credits.available"] = await credits.getBalance(userId);
    return result;
  };
  const authorize = async (rule: Rule) => {
    const rights = await access.permission(rule.editor_ref);
    access.audience(rule.editor_ref, rights, rule.definition.audience);
    if (rule.definition.condition.type === "javascript" && !rights.canScript) fail("JavaScript rule permission required", 403);
    if (rule.definition.condition.type === "llm" && !rights.canLlm) fail("LLM rule permission required", 403);
    return rights;
  };
  const eligible = async (message: Message) => {
    if (!message.automation) return true; // Core-owned security email.
    const metadata = message.automation;
    try {
      const { rows: [rule] } = await ctx.db.query<Rule>("SELECT * FROM rules WHERE id=$1 AND enabled AND revision=$2", [metadata.ruleId, metadata.revision]);
      if (!rule) return false;
      await authorize(rule);
      if (!(await access.subjects(rule.definition.audience)).includes(metadata.subjectId)) return false;
      const channels = await access.channels(rule.definition);
      const channel = channels.find((item) => item.id === metadata.channelId);
      if (!channel?.enabled || channel.revision !== metadata.channelRevision) return false;
      const [user] = await access.directory().getUsers([metadata.subjectId]);
      return !!user?.isEnabled && (message.kind !== "email" || (user.emailVerified && user.email === message.to));
    } catch (error) {
      if (error instanceof NotificationError && [401, 403, 404].includes(error.status)) return false;
      throw error; // Infrastructure failures retry; do not discard valid jobs.
    }
  };
  const runOne = async (): Promise<boolean> => {
    let state: State | undefined;
    try {
      const token = randomUUID();
      const claimed = await ctx.db.query<State>(`WITH candidate AS (
        SELECT s.rule_id,s.subject_ref FROM rule_states s JOIN rules r ON r.id=s.rule_id
        WHERE r.enabled AND s.due_at<=now() AND (s.lease_token IS NULL OR s.lease_until<=now())
        ORDER BY s.due_at,s.rule_id,s.subject_ref LIMIT 1 FOR UPDATE OF s SKIP LOCKED)
        UPDATE rule_states s SET lease_token=$1,lease_until=now()+interval '60 seconds'
        FROM candidate c WHERE s.rule_id=c.rule_id AND s.subject_ref=c.subject_ref RETURNING s.*`, [token]);
      state = claimed.rows[0];
      if (!state) return false;
      const { rows: [rule] } = await ctx.db.query<Rule>("SELECT * FROM rules WHERE id=$1 AND enabled", [state.rule_id]);
      if (!rule) return true;
      await authorize(rule);
      if (!(await access.subjects(rule.definition.audience)).includes(state.subject_ref)) fail("Recipient is no longer in the audience", 403);
      const [user] = await access.directory().getUsers([state.subject_ref]);
      if (!user?.isEnabled) fail("Recipient account is unavailable", 403);
      const channelRows = await access.channels(rule.definition);
      const input = await snapshot(state.subject_ref);
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      if (hash === state.last_hash) {
        await ctx.db.query("UPDATE rule_states SET due_at=now()+($4 * interval '1 second'),lease_token=NULL,lease_until=NULL,last_evaluated_at=now(),last_error=NULL WHERE rule_id=$1 AND subject_ref=$2 AND lease_token=$3",
          [state.rule_id, state.subject_ref, token, rule.definition.intervalSeconds]);
        return true;
      }
      const result = await evaluator.evaluate(rule.definition.condition, input);
      const fire = result.matched && (!state.last_matched || !state.last_fired_at || Date.now() - new Date(state.last_fired_at).getTime() >= rule.definition.cooldownSeconds * 1000);
      const eventId = randomUUID();
      const variables = { ...input.metrics, rule: rule.definition.name, username: user.username, result: result.summary };
      const messages = fire ? channelRows.filter((channel) => channel.enabled && (channel.kind !== "email" || user.emailVerified)).map((channel) => ({
        channelId: channel.id,
        payload: encryption.encrypt(JSON.stringify({
          kind: channel.kind, subject: render(rule.definition.subject, variables).slice(0, 160), text: render(rule.definition.message, variables).slice(0, 1800),
          ...(channel.kind === "email" ? { to: user.email } : { webhookUrl: encryption.decrypt(channel.destination_ciphertext!) }),
          automation: { ruleId: rule.id, revision: rule.revision, channelId: channel.id, channelRevision: channel.revision, subjectId: state!.subject_ref },
        } satisfies Message)),
      })) : [];
      await ctx.db.withTransaction(async (tx) => {
        const live = await tx.query("SELECT 1 FROM rule_states s JOIN rules r ON r.id=s.rule_id WHERE s.rule_id=$1 AND s.subject_ref=$2 AND s.lease_token=$3 AND s.lease_until>now() AND r.enabled AND r.revision=$4 FOR UPDATE OF s,r", [rule.id, state!.subject_ref, token, rule.revision]);
        if (!live.rows.length) return;
        if (fire) {
          await tx.query("INSERT INTO events(id,rule_id,rule_revision,subject_ref,matched,summary) VALUES($1,$2,$3,$4,true,$5)", [eventId, rule.id, rule.revision, state!.subject_ref, result.summary]);
          for (const message of messages) await tx.query("INSERT INTO deliveries(idempotency_key,payload_ciphertext,expires_at,rule_id,subject_ref,channel_id) VALUES($1,$2,now()+interval '24 hours',$3,$4,$5) ON CONFLICT(idempotency_key) DO NOTHING", [`rule:${eventId}:${message.channelId}`, message.payload, rule.id, state!.subject_ref, message.channelId]);
        }
        await tx.query(`UPDATE rule_states SET last_hash=$4,last_matched=$5,last_fired_at=CASE WHEN $6 THEN now() ELSE last_fired_at END,
          last_evaluated_at=now(),last_error=NULL,due_at=now()+($7 * interval '1 second'),lease_token=NULL,lease_until=NULL
          WHERE rule_id=$1 AND subject_ref=$2 AND lease_token=$3`, [rule.id, state!.subject_ref, token, hash, result.matched, fire, rule.definition.intervalSeconds]);
      });
      return true;
    } catch (error) {
      if (state) await ctx.db.query("UPDATE rule_states SET due_at=now()+interval '15 minutes',lease_token=NULL,lease_until=NULL,last_evaluated_at=now(),last_error=$4 WHERE rule_id=$1 AND subject_ref=$2 AND lease_token=$3",
        [state.rule_id, state.subject_ref, state.lease_token, error instanceof NotificationError ? error.message : "Rule evaluation failed; check service configuration"]);
      ctx.logger.warn("Notification rule could not be evaluated", { ruleId: state?.rule_id });
      return !!state;
    }
  };
  let running = false;
  const run = async () => {
    if (running || !encryption.configured()) return;
    running = true;
    const deadline = Date.now() + 2500;
    try {
      for (let count = 0; count < 20; count++) {
        if (!await runOne() || Date.now() >= deadline) break;
      }
    } finally { running = false; }
  };
  return { ...evaluator, snapshot, authorize, eligible, run,
    async syncSubjects(ruleId: string, ids: number[], db = ctx.db) {
      await db.query("DELETE FROM rule_states WHERE rule_id=$1 AND NOT(subject_ref=ANY($2::int[]))", [ruleId, ids]);
      for (const id of ids) await db.query("INSERT INTO rule_states(rule_id,subject_ref) VALUES($1,$2) ON CONFLICT(rule_id,subject_ref) DO NOTHING", [ruleId, id]);
    },
  };
}
export type Automation = ReturnType<typeof createAutomation>;
