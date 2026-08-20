-- Collapse eval_agent_tokens.visibility into dispatch_tier, then drop it.
-- Only tokens still at the untouched default tier ('public') that were marked
-- private become 'private' tier — exactly the retroactive fix for tokens born
-- dispatch_tier='public' despite visibility='private'. Tokens already PATCHed to
-- 'shared'/'team' are left as-is; visibility='public' stays 'public'.
UPDATE "eval_agent_tokens"
   SET "dispatch_tier" = 'private'
 WHERE "visibility" = 'private'
   AND "dispatch_tier" = 'public';
--> statement-breakpoint
ALTER TABLE "eval_agent_tokens" DROP COLUMN "visibility";
