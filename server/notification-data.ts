import type { NotificationDataService } from "@vox/plugin-sdk";
import { pool } from "./storage";

// The plugin enforces its explicit user/group permissions. This read-only seam
// returns numeric personal data only, never artifacts, transcripts or org jobs.
export const notificationDataService: NotificationDataService = {
  async getSnapshot(userId) {
    const [counts, history] = await Promise.all([
      pool.query(`SELECT count(*) FILTER(WHERE status='failed' AND created_at>=now()-interval '24 hours')::int AS failed,
        count(*) FILTER(WHERE status='completed' AND created_at>=now()-interval '24 hours')::int AS completed,
        count(*) FILTER(WHERE status='running')::int AS running
        FROM eval_jobs WHERE created_by=$1 AND creator_org_id IS NULL AND kind='eval' AND deleted_at IS NULL
        AND (created_at>=now()-interval '24 hours' OR status='running')`, [userId]),
      pool.query(`WITH recent_jobs AS (SELECT id FROM eval_jobs
        WHERE created_by=$1 AND creator_org_id IS NULL AND kind='eval' AND deleted_at IS NULL
        ORDER BY created_at DESC,id DESC LIMIT 100)
        SELECT r.id,r.created_at,r.response_latency_median,r.turn_success_rate
        FROM eval_results r JOIN recent_jobs j ON j.id=r.eval_job_id
        ORDER BY r.created_at DESC,r.id DESC LIMIT 50`, [userId]),
    ]);
    const samples = history.rows.map((row) => ({ id: row.id as number, at: new Date(row.created_at).toISOString(),
      values: { "eval.responseLatencyMs": row.response_latency_median as number | null, "eval.turnSuccessRate": row.turn_success_rate as number | null } }));
    return { metrics: {
      "jobs.failed24h": counts.rows[0].failed, "jobs.completed24h": counts.rows[0].completed, "jobs.running": counts.rows[0].running,
      "eval.responseLatencyMs": samples[0]?.values["eval.responseLatencyMs"] ?? null,
      "eval.turnSuccessRate": samples[0]?.values["eval.turnSuccessRate"] ?? null,
    }, samples };
  },
};
