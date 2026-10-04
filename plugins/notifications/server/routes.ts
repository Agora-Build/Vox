import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Handler, SecretEncryptionService, VoxPluginContext } from "@vox/plugin-sdk";
import type { Access } from "./access";
import type { Automation } from "./automation";
import { channelSchema, discordDestination, fail, groupSchema, METRICS, NotificationError, permissionSchema, ruleSchema, type Channel, type Rule } from "../configuration";

export function registerRoutes(ctx: VoxPluginContext, encryption: SecretEncryptionService, access: Access, automation: Automation, canSendEmail: () => boolean) {
  const route = (handler: Handler): Handler => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((error) => {
      const status = error instanceof NotificationError ? error.status : error instanceof z.ZodError ? 400 : 500;
      if (status === 500) ctx.logger.error("Notification operation failed");
      res.status(status).json({ error: error instanceof NotificationError ? error.message : status === 400 ? "Invalid notification request" : "Notification operation failed; please retry" });
    });
  };
  const visibleChannel = async (userId: number, id: string) => {
    const { rows: [channel] } = await ctx.db.query<Channel>("SELECT * FROM channels WHERE id=$1", [z.string().uuid().parse(id)]);
    if (!channel) fail("Channel not found", 404);
    access.manageChannel(userId, await access.permission(userId), channel);
    return channel;
  };
  const validateRule = async (userId: number, definition: Rule["definition"]) => {
    await automation.authorize({ id: "", editor_ref: userId, definition, enabled: definition.enabled, revision: "" });
    const ids = await access.subjects(definition.audience);
    if ((await access.directory().getUsers(ids)).length !== ids.length) fail("Audience includes an unavailable account");
    await access.channels(definition);
    if (definition.condition.type === "llm" && !automation.llmAvailable) fail("Configure the server's LLM provider before saving an LLM rule", 503);
    if (!encryption.configured()) fail("Server encryption must be configured", 503);
    return ids;
  };
  ctx.http((r) => {
    r.get("/settings", r.requireAuth, route(async (req, res) => {
      const userId = req.session.userId!;
      const rights = await access.permission(userId);
      const { rows: groups } = await ctx.db.query("SELECT id,name,user_refs FROM audience_groups WHERE $1 OR id=ANY($2::uuid[]) OR $3=ANY(user_refs) ORDER BY name LIMIT 100", [rights.isAdmin, rights.groupIds, userId]);
      res.json({ permission: rights, emailAvailable: canSendEmail(), encryptionConfigured: encryption.configured(), llmAvailable: automation.llmAvailable, llmDailyLimit: automation.dailyLimit, metrics: METRICS, groups: (groups as Array<{ id: string; name: string }>).map(({ id, name }) => ({ id, name })) });
    }));
    r.get("/channels", r.requireAuth, route(async (req, res) => {
      const rights = await access.permission(req.session.userId!);
      const { rows } = await ctx.db.query("SELECT id,name,kind,owner_ref,group_id,enabled,revision FROM channels WHERE $1 OR owner_ref=$2 OR group_id=ANY($3::uuid[]) ORDER BY created_at DESC LIMIT 200", [rights.isAdmin, req.session.userId, rights.canEdit ? rights.groupIds : []]);
      res.json(rows);
    }));
    r.post("/channels", r.requireAuth, route(async (req, res) => {
      const input = channelSchema.parse(req.body);
      const userId = req.session.userId!;
      const rights = await access.permission(userId);
      access.manageChannel(userId, rights, { owner_ref: userId, group_id: input.groupId });
      if (input.groupId) await access.subjects({ type: "group", groupId: input.groupId });
      if (!encryption.configured()) fail("Server encryption must be configured", 503);
      const destination = input.kind === "discord" ? encryption.encrypt(discordDestination(input.webhookUrl ?? "")) : null;
      if (input.kind === "email" && input.webhookUrl) fail("Email channels use each recipient's verified account email");
      const id = randomUUID();
      await ctx.db.withTransaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(74201,$1)", [userId]);
        const count = await tx.query<{ count: string }>("SELECT count(*) FROM channels WHERE owner_ref=$1", [userId]);
        if (Number(count.rows[0].count) >= 50) fail("Channel limit reached");
        await tx.query("INSERT INTO channels(id,owner_ref,group_id,name,kind,destination_ciphertext,enabled,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, userId, input.groupId, input.name, input.kind, destination, input.enabled, randomUUID()]);
        await tx.query("INSERT INTO audit_log(actor_ref,action,object_id) VALUES($1,'channel.create',$2)", [userId, id]);
      });
      res.status(201).json({ id });
    }));
    r.patch("/channels/:id", r.requireAuth, route(async (req, res) => {
      const current = await visibleChannel(req.session.userId!, String(req.params.id));
      const input = z.object({ revision: z.string().uuid(), enabled: z.boolean(), name: z.string().trim().min(1).max(80), webhookUrl: z.string().max(300).optional() }).strict().parse(req.body);
      if (current.kind === "email" && input.webhookUrl) fail("Email channels do not accept webhook destinations");
      const destination = input.webhookUrl ? encryption.encrypt(discordDestination(input.webhookUrl)) : current.destination_ciphertext;
      const result = await ctx.db.query("UPDATE channels SET name=$3,enabled=$4,destination_ciphertext=$5,revision=$6 WHERE id=$1 AND revision=$2 RETURNING id", [current.id, input.revision, input.name, input.enabled, destination, randomUUID()]);
      if (!result.rows.length) fail("Channel changed; reload before editing", 409);
      await access.audit(req.session.userId!, "channel.update", current.id);
      res.json({ ok: true });
    }));
    r.get("/rules", r.requireAuth, route(async (req, res) => {
      const userId = req.session.userId!;
      const rights = await access.permission(userId);
      const { rows } = await ctx.db.query<Rule & { last_error: string | null }>(`SELECT r.*, (SELECT max(last_error) FROM rule_states s WHERE s.rule_id=r.id) AS last_error
        FROM rules r WHERE $1 OR (definition->'audience'->>'type'='user' AND definition->'audience'->>'userId'=$2)
        OR (definition->'audience'->>'type'='group' AND definition->'audience'->>'groupId'=ANY($3::text[])) ORDER BY updated_at DESC LIMIT 200`, [rights.isAdmin, String(userId), rights.canEdit ? rights.groupIds : []]);
      res.json(rows);
    }));
    r.post("/rules", r.requireAuth, route(async (req, res) => {
      const definition = ruleSchema.parse(req.body);
      const userId = req.session.userId!;
      const ids = await validateRule(userId, definition);
      const id = randomUUID();
      await ctx.db.withTransaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(74202,$1)", [userId]);
        const count = await tx.query<{ count: string }>("SELECT count(*) FROM rules WHERE editor_ref=$1", [userId]);
        if (Number(count.rows[0].count) >= 100) fail("Rule limit reached");
        await tx.query("INSERT INTO rules(id,editor_ref,definition,revision,enabled) VALUES($1,$2,$3,$4,$5)", [id, userId, JSON.stringify(definition), randomUUID(), definition.enabled]);
        await automation.syncSubjects(id, ids, tx);
        await tx.query("INSERT INTO audit_log(actor_ref,action,object_id) VALUES($1,'rule.create',$2)", [userId, id]);
      });
      res.status(201).json({ id });
    }));
    r.patch("/rules/:id", r.requireAuth, route(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const input = z.object({ revision: z.string().uuid(), definition: ruleSchema }).strict().parse(req.body);
      const { rows: [current] } = await ctx.db.query<Rule>("SELECT * FROM rules WHERE id=$1", [id]);
      if (!current) fail("Rule not found", 404);
      const rights = await access.permission(req.session.userId!);
      access.audience(req.session.userId!, rights, current.definition.audience);
      const ids = await validateRule(req.session.userId!, input.definition);
      await ctx.db.withTransaction(async (tx) => {
        const changed = await tx.query("UPDATE rules SET definition=$3,revision=$4,enabled=$5,editor_ref=$6,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING id", [id, input.revision, JSON.stringify(input.definition), randomUUID(), input.definition.enabled, req.session.userId]);
        if (!changed.rows.length) fail("Rule changed; reload before editing", 409);
        await automation.syncSubjects(id, ids, tx);
        await tx.query("UPDATE rule_states SET last_hash=NULL,last_matched=false,last_fired_at=NULL,due_at=now(),lease_token=NULL,lease_until=NULL WHERE rule_id=$1", [id]);
        await tx.query("INSERT INTO audit_log(actor_ref,action,object_id) VALUES($1,'rule.update',$2)", [req.session.userId, id]);
      });
      res.json({ ok: true });
    }));
    r.post("/preview", r.requireAuth, route(async (req, res) => {
      const definition = ruleSchema.parse(req.body);
      await validateRule(req.session.userId!, definition);
      const ids = await access.subjects(definition.audience);
      // Preview one member, never send; LLM previews consume the same budget.
      const result = await automation.evaluate(definition.condition, await automation.snapshot(ids[0]));
      res.json({ subjectId: ids[0], ...result });
    }));
    r.get("/activity", r.requireAuth, route(async (req, res) => {
      const userId = req.session.userId!;
      const rights = await access.permission(userId);
      const { rows } = await ctx.db.query(`SELECT e.id,e.subject_ref,e.summary,e.created_at,r.definition->>'name' AS rule_name,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',d.id,'status',d.status,'attempts',d.attempts)) FROM deliveries d WHERE d.idempotency_key LIKE ('rule:'||e.id::text||':%')),'[]'::jsonb) AS deliveries
        FROM events e LEFT JOIN rules r ON r.id=e.rule_id WHERE ($1 OR e.subject_ref=$2 OR ($3 AND r.definition->'audience'->>'type'='group' AND r.definition->'audience'->>'groupId'=ANY($4::text[])))
        AND ($1 OR e.subject_ref=$2 OR EXISTS (SELECT 1 FROM audience_groups g WHERE g.id::text=r.definition->'audience'->>'groupId' AND e.subject_ref=ANY(g.user_refs)))
        ORDER BY e.created_at DESC LIMIT 100`, [rights.isAdmin, userId, rights.canEdit, rights.groupIds]);
      res.json(rows);
    }));
    r.get("/access", r.requireAuth, r.requireAdmin, route(async (_req, res) => {
      const [permissions, groups, audit] = await Promise.all([
        ctx.db.query("SELECT * FROM editor_permissions ORDER BY user_ref LIMIT 500"),
        ctx.db.query("SELECT * FROM audience_groups ORDER BY name LIMIT 100"),
        ctx.db.query("SELECT actor_ref,action,object_id,created_at FROM audit_log ORDER BY id DESC LIMIT 100"),
      ]);
      res.json({ permissions: permissions.rows, groups: groups.rows, audit: audit.rows });
    }));
    r.post("/access", r.requireAuth, r.requireAdmin, route(async (req, res) => {
      const input = permissionSchema.parse(req.body);
      if ((await access.directory().getUsers([input.userId])).length !== 1) fail("User not found");
      const groups = await ctx.db.query("SELECT id FROM audience_groups WHERE id=ANY($1::uuid[])", [input.groupIds]);
      if (groups.rows.length !== input.groupIds.length) fail("One or more groups do not exist");
      await ctx.db.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO editor_permissions(user_ref,can_edit,can_script,can_llm,group_ids,updated_by) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(user_ref) DO UPDATE SET can_edit=EXCLUDED.can_edit,can_script=EXCLUDED.can_script,can_llm=EXCLUDED.can_llm,group_ids=EXCLUDED.group_ids,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [input.userId, input.canEdit, input.canScript, input.canLlm, input.groupIds, req.session.userId]);
        await tx.query("INSERT INTO audit_log(actor_ref,action,object_id) VALUES($1,'access.update',$2)", [req.session.userId, String(input.userId)]);
      });
      res.json({ ok: true });
    }));
    r.post("/groups", r.requireAuth, r.requireAdmin, route(async (req, res) => {
      const input = groupSchema.parse(req.body);
      if ((await access.directory().getUsers(input.userIds)).length !== input.userIds.length) fail("One or more group members do not exist");
      const id = randomUUID();
      await ctx.db.query("INSERT INTO audience_groups(id,name,user_refs,created_by) VALUES($1,$2,$3,$4)", [id, input.name, input.userIds, req.session.userId]);
      await access.audit(req.session.userId!, "group.create", id);
      res.status(201).json({ id });
    }));
    r.patch("/groups/:id", r.requireAuth, r.requireAdmin, route(async (req, res) => {
      const id = z.string().uuid().parse(req.params.id);
      const input = groupSchema.parse(req.body);
      if ((await access.directory().getUsers(input.userIds)).length !== input.userIds.length) fail("One or more group members do not exist");
      await ctx.db.withTransaction(async (tx) => {
        const changed = await tx.query("UPDATE audience_groups SET name=$2,user_refs=$3,updated_at=now() WHERE id=$1 RETURNING id", [id, input.name, input.userIds]);
        if (!changed.rows.length) fail("Group not found", 404);
        const { rows: rules } = await tx.query<Rule>("UPDATE rules SET revision=gen_random_uuid(),updated_at=now() WHERE definition->'audience'->>'type'='group' AND definition->'audience'->>'groupId'=$1 RETURNING *", [id]);
        for (const rule of rules) {
          await automation.syncSubjects(rule.id, input.userIds, tx);
          await tx.query("UPDATE rule_states SET last_hash=NULL,last_matched=false,last_fired_at=NULL,due_at=now(),lease_token=NULL,lease_until=NULL WHERE rule_id=$1", [rule.id]);
        }
        await tx.query("INSERT INTO audit_log(actor_ref,action,object_id) VALUES($1,'group.update',$2)", [req.session.userId, id]);
      });
      res.json({ ok: true });
    }));
  });
}
