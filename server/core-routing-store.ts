import type { Pool } from "pg";
import type { CoreDirectory, CoreOwner, CoreResourceKind } from "./core-routing";

const columns = `kind, resource_id AS "resourceId", core_id AS "coreId", origin, generation, lease_id AS "leaseId"`;
// Claim/renew are fenced by the business lease, not just a process's memory.
const currentLease = `(kind = 'agent' AND EXISTS (SELECT 1 FROM eval_agents WHERE id = resource_id AND current_lease_id = lease_id))
  OR (kind = 'broker' AND EXISTS (SELECT 1 FROM brokers WHERE id = resource_id AND current_lease_id = lease_id))`;
export class PgCoreDirectory implements CoreDirectory {
  constructor(private pool: Pool) {}
  async claim(owner: CoreOwner): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const table = owner.kind === "agent" ? "eval_agents" : "brokers";
      const current = await client.query(`SELECT id FROM ${table} WHERE id = $1 AND current_lease_id = $2 FOR UPDATE`, [owner.resourceId, owner.leaseId]);
      if (!current.rowCount) { await client.query("ROLLBACK"); return false; }
      await client.query(`INSERT INTO core_connection_owners (kind, resource_id, core_id, origin, generation, lease_id, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + interval '30 seconds')
      ON CONFLICT (kind, resource_id) DO UPDATE SET core_id = EXCLUDED.core_id, origin = EXCLUDED.origin,
        generation = EXCLUDED.generation, lease_id = EXCLUDED.lease_id, expires_at = EXCLUDED.expires_at`,
      [owner.kind, owner.resourceId, owner.coreId, owner.origin, owner.generation, owner.leaseId]);
      await client.query("COMMIT"); return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async find(kind: CoreResourceKind, id: number): Promise<CoreOwner | null> {
    const { rows } = await this.pool.query<CoreOwner>(`SELECT ${columns} FROM core_connection_owners
      WHERE kind = $1 AND resource_id = $2 AND expires_at > clock_timestamp() AND (${currentLease})`, [kind, id]);
    return rows[0] ?? null;
  }
  async renew(owner: CoreOwner): Promise<boolean> {
    const result = await this.pool.query(`UPDATE core_connection_owners SET expires_at = clock_timestamp() + interval '30 seconds'
      WHERE kind = $1 AND resource_id = $2 AND core_id = $3 AND generation = $4 AND lease_id = $5
        AND expires_at > clock_timestamp() AND (${currentLease})`, [owner.kind, owner.resourceId, owner.coreId, owner.generation, owner.leaseId]);
    return result.rowCount === 1;
  }
  async release(owner: CoreOwner): Promise<void> {
    await this.pool.query(`DELETE FROM core_connection_owners WHERE kind = $1 AND resource_id = $2 AND core_id = $3 AND generation = $4`,
      [owner.kind, owner.resourceId, owner.coreId, owner.generation]);
  }
  async acceptNonce(nonce: string): Promise<boolean> {
    const result = await this.pool.query(`INSERT INTO core_routing_nonces (nonce, expires_at) VALUES ($1, clock_timestamp() + interval '65 seconds')
      ON CONFLICT DO NOTHING`, [nonce]);
    return result.rowCount === 1;
  }
  async prune(): Promise<void> {
    await this.pool.query("DELETE FROM core_routing_nonces WHERE expires_at < clock_timestamp()");
    await this.pool.query("DELETE FROM core_connection_owners WHERE expires_at < clock_timestamp()");
  }
}
