import type { Pool } from "pg";
import { pool } from "./storage";

export type BrowserTarget = {
  key: string; kind: "agent"; agentId: number; leaseId: string; generation: string; jobId: number; startedAt: string;
} | {
  key: string; kind: "broker"; brokerId: number; generation: string; operationId: string; deadline: string;
};
export type BrowserGrant = { id: string; userId: number; jobId: number; target: BrowserTarget };
const columns = `id, user_id AS "userId", job_id AS "jobId", target`;

export class PgBrowserViewers {
  constructor(private db: Pool) {}
  async create(grant: BrowserGrant): Promise<boolean> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(987654323)");
      const result = await client.query(`INSERT INTO browser_viewer_grants (id, user_id, job_id, target_key, target, expires_at)
      SELECT $1, $2, $3, $4, $5, clock_timestamp() + interval '6 seconds'
      WHERE (SELECT count(*) FROM browser_viewer_grants WHERE expires_at > clock_timestamp()) < 100
        AND (SELECT count(*) FROM browser_viewer_grants WHERE target_key = $4 AND expires_at > clock_timestamp()) < 10
      RETURNING id`,
    [grant.id, grant.userId, grant.jobId, grant.target.key, JSON.stringify(grant.target)]);
      await client.query("COMMIT"); return result.rowCount === 1;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async get(id: string): Promise<BrowserGrant | null> {
    const { rows } = await this.db.query<BrowserGrant>(`SELECT ${columns} FROM browser_viewer_grants WHERE id = $1 AND expires_at > clock_timestamp()`, [id]);
    return rows[0] ?? null;
  }
  async list(targetKey: string): Promise<BrowserGrant[]> {
    return (await this.db.query<BrowserGrant>(`SELECT ${columns} FROM browser_viewer_grants
      WHERE target_key = $1 AND expires_at > clock_timestamp()`, [targetKey])).rows;
  }
  async touch(grant: BrowserGrant): Promise<boolean> {
    const result = await this.db.query(`UPDATE browser_viewer_grants SET expires_at = clock_timestamp() + interval '6 seconds'
      WHERE id = $1 AND user_id = $2 AND job_id = $3 AND target_key = $4 AND expires_at > clock_timestamp()`,
    [grant.id, grant.userId, grant.jobId, grant.target.key]);
    return result.rowCount === 1;
  }
  async remove(id: string, userId?: number, jobId?: number): Promise<BrowserGrant | null> {
    const { rows } = await this.db.query<BrowserGrant>(`DELETE FROM browser_viewer_grants
      WHERE id = $1 AND ($2::integer IS NULL OR user_id = $2) AND ($3::integer IS NULL OR job_id = $3) RETURNING ${columns}`,
    [id, userId ?? null, jobId ?? null]);
    return rows[0] ?? null;
  }
  async removeJob(jobId: number): Promise<BrowserGrant[]> {
    return (await this.db.query<BrowserGrant>(`DELETE FROM browser_viewer_grants WHERE job_id = $1 RETURNING ${columns}`, [jobId])).rows;
  }
  async expire(): Promise<BrowserGrant[]> {
    return (await this.db.query<BrowserGrant>(`DELETE FROM browser_viewer_grants WHERE id IN
      (SELECT id FROM browser_viewer_grants WHERE expires_at < clock_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING ${columns}`)).rows;
  }
}
export const browserViewers = new PgBrowserViewers(pool);
