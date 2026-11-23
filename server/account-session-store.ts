import type { Pool, PoolClient } from "pg";
import { encryptValue, decryptValue, isEncryptionConfigured } from "./storage";
import { AccountSessionError, sessionDigest, type AccountSessionBinding } from "./account-session-binding";
import { parseAccountJson } from "../shared/account-session-protocol";

export interface AccountSessionAuthority {
  binding: AccountSessionBinding;
  /** Core-derived job/claim/execution or trusted-broker mint identity, not file-asserted authority. */
  executionKey: string;
  validUntil: Date;
}

/**
 * The integration must recheck live credentials, eligibility and claim/mint here,
 * locking the relevant Core authority rows until this transaction commits. Org
 * reads must use the organizations seam.
 */
export type AuthorizeAccountSession = (client: PoolClient) => Promise<AccountSessionAuthority | null>;

export interface AccountSessionTicket {
  sessionKey: string;
  generation: number;
  executionKey: string;
  expiresAt: Date;
}

export interface AccountSessionCheckpoint {
  checkpointId: string;
  sequence: number;
  format: string;
  /** Exact immutable snapshot bytes, not a mutable working-file read. */
  state: string;
}

export type AccountSessionSaveResult =
  | { status: "persisted"; checkpointId: string; committedAt: Date }
  | { status: "superseded" }
  | { status: "rejected"; reason: "conflicting-checkpoint" | "refresh-expired" | "capacity" };

interface SessionRow {
  session_key: string;
  generation: number;
  refresh_owner: string | null;
  refresh_expires_at: Date | null;
  last_sequence: string; // pg returns bigint as text; convert only after contract bounds checking.
  encrypted_storage_state: string | null;
  storage_format: string | null;
}

interface StoreOptions {
  maxStateBytes: number;
  maxCheckpointsPerRefresh: number;
  /** Required provider/format/scope validator, supplied by the qualified integration. */
  acceptsState: (binding: AccountSessionBinding, format: string, state: unknown) => boolean;
}

/** Encrypted state and receipt commit under the same live-authority transaction. */
export class AccountSessionStore {
  constructor(private readonly pool: Pick<Pool, "connect">, private readonly options: StoreOptions) {
    if (![options.maxStateBytes, options.maxCheckpointsPerRefresh].every(n => Number.isSafeInteger(n) && n > 0) ||
        typeof options.acceptsState !== "function") throw new AccountSessionError("invalid-state");
  }

  private parse(binding: AccountSessionBinding, format: string, state: string): unknown {
    try {
      if (typeof state !== "string" || Buffer.byteLength(state) > this.options.maxStateBytes ||
          typeof format !== "string" || !format || format.length > 100) throw new Error();
      const parsed = parseAccountJson(state);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
          !this.options.acceptsState(binding, format, parsed)) throw new Error();
      return parsed;
    } catch { throw new AccountSessionError("invalid-state"); }
  }

  private async authorized<T>(authorize: AuthorizeAccountSession,
    work: (client: PoolClient, authority: AccountSessionAuthority) => Promise<T>): Promise<T> {
    if (!isEncryptionConfigured()) throw new AccountSessionError("state-unavailable");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const verified = await authorize(client);
      if (!verified || typeof verified.executionKey !== "string" || !verified.executionKey || verified.executionKey.length > 512 ||
          !(verified.validUntil instanceof Date) || !Number.isFinite(verified.validUntil.getTime())) throw new AccountSessionError("unauthorized");
      const authority = { binding: verified.binding, executionKey: verified.executionKey,
        validUntil: new Date(verified.validUntil) };
      await this.checkDeadline(client, authority.validUntil);
      const result = await work(client, authority);
      // Recheck before COMMIT as well: persistence never extends a lease or
      // trusts a binding/credential revision cached before the transaction.
      const current = await authorize(client);
      if (!current || current.binding.sessionKey !== authority.binding.sessionKey ||
          current.executionKey !== authority.executionKey ||
          !(current.validUntil instanceof Date) || !Number.isFinite(current.validUntil.getTime())) throw new AccountSessionError("unauthorized");
      await this.checkDeadline(client, new Date(Math.min(authority.validUntil.getTime(), current.validUntil.getTime())));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // A lost COMMIT response has an unknown outcome. Preserve that original
      // error even if the disconnected client cannot roll back; retry by receipt.
      try { await client.query("ROLLBACK"); } catch { /* Connection may already be gone. */ }
      throw error;
    } finally { client.release(); }
  }

  private async checkDeadline(client: PoolClient, deadline: Date): Promise<void> {
    const result = await client.query("SELECT clock_timestamp() < $1::timestamptz AS valid", [deadline]);
    if (!result.rows[0]?.valid) throw new AccountSessionError("unauthorized");
  }

  async read(authorize: AuthorizeAccountSession): Promise<{ format: string; state: string } | null> {
    return this.authorized(authorize, async (client, { binding }) => {
      const { rows } = await client.query<SessionRow>("SELECT * FROM account_sessions WHERE session_key = $1", [binding.sessionKey]);
      const row = rows[0];
      if (!row?.encrypted_storage_state) return null;
      try {
        const envelope = JSON.parse(decryptValue(row.encrypted_storage_state));
        if (envelope.version !== 1 || envelope.sessionKey !== binding.sessionKey ||
            envelope.format !== row.storage_format) throw new Error();
        this.parse(binding, envelope.format, envelope.state);
        return { format: envelope.format as string, state: envelope.state as string };
      } catch { throw new AccountSessionError("state-unavailable"); }
    });
  }

  async claim(authorize: AuthorizeAccountSession, ttlSeconds: number): Promise<AccountSessionTicket | null> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) throw new AccountSessionError("invalid-checkpoint");
    return this.authorized(authorize, async (client, authority) => {
      const b = authority.binding;
      await client.query(`INSERT INTO account_sessions
        (session_key, user_id, organization_id, source, platform_id, tenant_key, credential_revision)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (session_key) DO NOTHING`,
      [b.sessionKey, b.userId, b.organizationId, b.source, b.platformId, b.tenantKey, b.credentialRevision]);
      const { rows } = await client.query<SessionRow & { active: boolean }>(`SELECT *,
        refresh_expires_at > clock_timestamp() AS active FROM account_sessions WHERE session_key = $1 FOR UPDATE`, [b.sessionKey]);
      const row = rows[0];
      if (row.active) {
        if (row.refresh_owner !== authority.executionKey) return null;
        return { sessionKey: b.sessionKey, generation: row.generation, executionKey: authority.executionKey, expiresAt: row.refresh_expires_at! };
      }
      const claimed = await client.query<SessionRow>(`UPDATE account_sessions SET generation = generation + 1,
        refresh_owner = $2, refresh_expires_at = LEAST(clock_timestamp() + make_interval(secs => $3), $4::timestamptz),
        last_sequence = 0, updated_at = clock_timestamp() WHERE session_key = $1 RETURNING *`,
      [b.sessionKey, authority.executionKey, ttlSeconds, authority.validUntil]);
      return { sessionKey: b.sessionKey, generation: claimed.rows[0].generation,
        executionKey: authority.executionKey, expiresAt: claimed.rows[0].refresh_expires_at! };
    });
  }

  async save(authorize: AuthorizeAccountSession, ticket: AccountSessionTicket,
    checkpoint: AccountSessionCheckpoint): Promise<AccountSessionSaveResult> {
    if (typeof checkpoint.checkpointId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(checkpoint.checkpointId) ||
        !Number.isInteger(checkpoint.sequence) || checkpoint.sequence <= 0 || checkpoint.sequence > 9_999_999_999 ||
        !Number.isInteger(ticket.generation) || ticket.generation <= 0 || ticket.generation > 2147483647) throw new AccountSessionError("invalid-checkpoint");
    return this.authorized(authorize, async (client, authority) => {
      if (ticket.sessionKey !== authority.binding.sessionKey || ticket.executionKey !== authority.executionKey) {
        throw new AccountSessionError("unauthorized");
      }
      this.parse(authority.binding, checkpoint.format, checkpoint.state);
      const hash = sessionDigest([checkpoint.format, checkpoint.state]);
      const { rows } = await client.query<SessionRow & { active: boolean }>(`SELECT *,
        refresh_expires_at > clock_timestamp() AS active FROM account_sessions WHERE session_key = $1 FOR UPDATE`, [ticket.sessionKey]);
      const row = rows[0];
      if (!row) return { status: "superseded" };
      const receipt = await client.query(`SELECT * FROM account_session_checkpoints
        WHERE session_key = $1 AND generation = $2 AND checkpoint_id = $3`, [ticket.sessionKey, ticket.generation, checkpoint.checkpointId]);
      const saved = receipt.rows[0];
      if (saved) {
        if (saved.execution_key !== authority.executionKey || saved.content_hash !== hash || Number(saved.sequence) !== checkpoint.sequence) {
          return { status: "rejected", reason: "conflicting-checkpoint" };
        }
        return { status: "persisted", checkpointId: checkpoint.checkpointId, committedAt: saved.committed_at };
      }
      if (row.generation !== ticket.generation || row.refresh_owner !== authority.executionKey) {
        return { status: "superseded" };
      }
      if (!row.active) return { status: "rejected", reason: "refresh-expired" };
      const sameSequence = await client.query(`SELECT 1 FROM account_session_checkpoints
        WHERE session_key = $1 AND generation = $2 AND sequence = $3`, [ticket.sessionKey, ticket.generation, checkpoint.sequence]);
      if (sameSequence.rowCount) return { status: "rejected", reason: "conflicting-checkpoint" };
      if (Number(row.last_sequence) >= checkpoint.sequence) return { status: "superseded" };
      const count = await client.query(`SELECT count(*)::integer AS n FROM account_session_checkpoints
        WHERE session_key = $1 AND generation = $2`, [ticket.sessionKey, ticket.generation]);
      if (count.rows[0].n >= this.options.maxCheckpointsPerRefresh) return { status: "rejected", reason: "capacity" };
      const encrypted = encryptValue(JSON.stringify({ version: 1, sessionKey: ticket.sessionKey,
        format: checkpoint.format, state: checkpoint.state }));
      await this.checkDeadline(client, row.refresh_expires_at!);
      await client.query(`UPDATE account_sessions SET encrypted_storage_state = $2, storage_format = $3,
        last_sequence = $4, updated_at = clock_timestamp() WHERE session_key = $1`,
      [ticket.sessionKey, encrypted, checkpoint.format, checkpoint.sequence]);
      const committed = await client.query(`INSERT INTO account_session_checkpoints
        (session_key, generation, checkpoint_id, execution_key, sequence, content_hash)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING committed_at`,
      [ticket.sessionKey, ticket.generation, checkpoint.checkpointId, authority.executionKey, checkpoint.sequence, hash]);
      return { status: "persisted", checkpointId: checkpoint.checkpointId, committedAt: committed.rows[0].committed_at };
    });
  }

  async release(authorize: AuthorizeAccountSession, ticket: AccountSessionTicket): Promise<boolean> {
    return this.authorized(authorize, async (client, authority) => {
      if (ticket.sessionKey !== authority.binding.sessionKey || ticket.executionKey !== authority.executionKey) {
        throw new AccountSessionError("unauthorized");
      }
      const result = await client.query(`UPDATE account_sessions SET refresh_owner = NULL,
        refresh_expires_at = NULL, updated_at = clock_timestamp()
        WHERE session_key = $1 AND generation = $2 AND refresh_owner = $3`,
      [ticket.sessionKey, ticket.generation, authority.executionKey]);
      // Failed/cancelled refreshes release their fence, never erase last good state.
      return result.rowCount === 1;
    });
  }
}
