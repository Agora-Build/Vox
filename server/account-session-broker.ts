import { randomBytes, randomUUID } from "node:crypto";
import type { WebSession } from "@shared/schema";
import { hashToken, pool, type SessionScope } from "./storage";
import { mintViaBroker, mintTimeoutSeconds, type BrokerTarget } from "./broker-registry";
import { accountSessionStore, brokerAccountAuthority, encodeAccountSessionGrant, type AccountSessionContext } from "./account-session-service";
import type { AccountSetup } from "@shared/account-session-setup";

/** web_sessions is only the mint-status index for this canonical state. */
export async function mintManagedAccountSession(input: {
  scope: SessionScope; need: AccountSetup; claimed: WebSession; target: BrokerTarget; operationId: string;
  bindingKey: string; email: string; password: string; ttlHours: number; fetchImpl: typeof fetch;
}) {
  if (!input.target.owner?.leaseId || !input.claimed.mintStartedAt) throw new Error("Account-session broker lease unavailable");
  const checkpointToken = randomBytes(32).toString("base64url");
  const context: Extract<AccountSessionContext, { kind: "brokered" }> = {
    kind: "brokered", version: 1, sessionId: `vox-mint-${randomUUID()}`, bindingKey: input.bindingKey,
    deadline: new Date(Date.now() + mintTimeoutSeconds() * 1000).toISOString(),
    mintId: input.claimed.id, mintStartedAt: input.claimed.mintStartedAt.toISOString(), brokerId: input.target.id,
    brokerLease: input.target.owner.leaseId, operationId: input.operationId, scope: input.scope, need: input.need,
    checkpointTokenHash: hashToken(checkpointToken),
  };
  const authorize = brokerAccountAuthority(context);
  // Do not replace state encrypted under a missing/wrong key or corrupt envelope.
  // Only missing state may proceed to login; undecryptable state needs recovery.
  const { ticket } = await accountSessionStore.claimAndRead(authorize, mintTimeoutSeconds());
  if (!ticket) throw new Error("Account-session refresh already in progress");
  let mintError: unknown;
  try {
    await mintViaBroker(input.target, { platformId: input.need.platformId, email: input.email, password: input.password,
      browserOperationId: input.operationId, sessionId: context.sessionId,
      checkpointGrant: encodeAccountSessionGrant(context, ticket), checkpointToken }, input.fetchImpl);
  } catch (error) { mintError = error; }
  // A confirmed checkpoint is independent of subsequent preview/analysis failure.
  // Check the committed receipt, never the mutable final file or broker's exit code.
  const receipts = await pool.query(`SELECT 1 FROM account_session_checkpoints
    WHERE session_key = $1 AND generation = $2 AND execution_key = $3 LIMIT 1`,
  [ticket.sessionKey, ticket.generation, ticket.executionKey]);
  try { await accountSessionStore.release(authorize, ticket); } catch { /* Deadline/revocation fences remain in force. */ }
  if (!receipts.rowCount) throw mintError ?? new Error("Broker produced no accepted authentication checkpoint");
  const result = await pool.query(`UPDATE web_sessions w SET status = 'ready', encrypted_storage_state = NULL,
    minted_at = now(), expires_at = now() + make_interval(secs => $3), last_error = NULL, updated_at = now()
    WHERE w.id = $1 AND w.status = 'minting' AND w.mint_started_at = $2 AND w.account_session_key = $4`,
  [input.claimed.id, input.claimed.mintStartedAt.toISOString(), Math.round(input.ttlHours * 3600), input.bindingKey]);
  return result.rowCount === 1;
}
