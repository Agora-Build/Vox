import type { UserDirectoryService, VoxPluginContext } from "@vox/plugin-sdk";
import { fail, type Channel, type Permission, type RuleDefinition } from "../configuration";

export function createAccess(ctx: VoxPluginContext) {
  const users = ctx.services.optional<UserDirectoryService>("vox.users", "^1.0.0");
  const directory = () => { if (!users) fail("Notification account services are unavailable", 503); return users; };
  const permission = async (userId: number): Promise<Permission> => {
    const [user] = await directory().getUsers([userId]);
    if (!user?.isEnabled) fail("Account unavailable", 401);
    if (user.isAdmin) return { isAdmin: true, canEdit: true, canScript: true, canLlm: true, groupIds: [] };
    const { rows: [grant] } = await ctx.db.query<{ can_edit: boolean; can_script: boolean; can_llm: boolean; group_ids: string[] }>("SELECT * FROM editor_permissions WHERE user_ref=$1", [userId]);
    return { isAdmin: false, canEdit: !!grant?.can_edit, canScript: !!grant?.can_script, canLlm: !!grant?.can_llm, groupIds: grant?.group_ids ?? [] };
  };
  const audience = (actorId: number, rights: Permission, target: RuleDefinition["audience"]) => {
    if (!rights.canEdit) fail("Notification editor access required", 403);
    if (rights.isAdmin || (target.type === "user" && target.userId === actorId) || (target.type === "group" && rights.groupIds.includes(target.groupId))) return;
    fail("This notification audience is not assigned to you", 403);
  };
  const subjects = async (target: RuleDefinition["audience"]): Promise<number[]> => {
    if (target.type === "user") return [target.userId];
    const { rows: [group] } = await ctx.db.query<{ user_refs: number[] }>("SELECT user_refs FROM audience_groups WHERE id=$1", [target.groupId]);
    if (!group) fail("Notification group not found", 404);
    return group.user_refs;
  };
  const manageChannel = (actorId: number, rights: Permission, channel: Pick<Channel, "owner_ref" | "group_id">) => {
    if (rights.isAdmin || (!channel.group_id && channel.owner_ref === actorId) || (rights.canEdit && channel.group_id && rights.groupIds.includes(channel.group_id))) return;
    fail("This notification channel is not assigned to you", 403);
  };
  const channels = async (definition: RuleDefinition): Promise<Channel[]> => {
    const { rows } = await ctx.db.query<Channel>("SELECT * FROM channels WHERE id=ANY($1::uuid[])", [definition.channelIds]);
    if (rows.length !== definition.channelIds.length) fail("One or more channels do not exist");
    for (const channel of rows) {
      const sameAudience = definition.audience.type === "group" ? channel.group_id === definition.audience.groupId : channel.group_id === null && channel.owner_ref === definition.audience.userId;
      if (!sameAudience) fail("All channels must belong to the rule's audience", 403);
    }
    return rows;
  };
  return { directory, permission, audience, subjects, manageChannel, channels,
    async audit(actorId: number, action: string, objectId: string) { await ctx.db.query("INSERT INTO audit_log(actor_ref,action,object_id) VALUES($1,$2,$3)", [actorId, action, objectId]); },
  };
}
export type Access = ReturnType<typeof createAccess>;
