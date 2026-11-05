import type { PoolClient } from "pg";
import type { EvalJob } from "@shared/schema";
import {
  networkReportSchema, networkEventTags, type NetworkReport, type NetworkAck,
  type NetworkHistory, type NetworkEventTags,
  type AgentNetworkEvent,
} from "@shared/network-events";
import { pool } from "./storage";
import { lookupAsn, normalizeIp } from "./location";
import { ispFromAsn, LINK_VALUES } from "@shared/tags";

export class NetworkReportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function parseNetworkReport(raw: unknown): NetworkReport | undefined {
  if (raw === undefined) return undefined;
  const parsed = networkReportSchema.safeParse(raw);
  if (!parsed.success) throw new NetworkReportError(400, "Invalid network event report");
  return parsed.data;
}

async function assertStoredEvent(client: PoolClient, job: Record<string, any>, event: AgentNetworkEvent): Promise<void> {
  const { rows: [prior] } = await client.query(`SELECT event, occurred_at, offset_ms, tags->>'link' AS link, changed
    FROM eval_job_network_events WHERE job_id = $1 AND started_at = $2 AND source = 'agent' AND seq = $3`,
  [job.id, job.started_at, event.seq]);
  if (!prior || prior.event !== event.event || new Date(prior.occurred_at).getTime() !== event.timestamp
    || prior.offset_ms !== event.offsetMs || prior.link !== event.tags.link
    || JSON.stringify(prior.changed) !== JSON.stringify(event.changed)) {
    throw new NetworkReportError(409, "Conflicting network event sequence");
  }
}

export async function initializeJobNetworkHistory(client: PoolClient, job: Record<string, any>, agent: Record<string, any>): Promise<void> {
  if (job.kind !== "eval") return;
  await client.query(`INSERT INTO eval_job_network_state
    (job_id, agent_id, lease_id, started_at, observed_ip, link_type, monitoring_gap)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (job_id) DO UPDATE SET agent_id = EXCLUDED.agent_id, lease_id = EXCLUDED.lease_id,
      started_at = EXCLUDED.started_at, observed_ip = EXCLUDED.observed_ip, link_type = EXCLUDED.link_type,
      first_seq = NULL, last_seq = NULL, monitoring_gap = EXCLUDED.monitoring_gap, finalized = false`,
  [job.id, job.eval_agent_id, agent.current_lease_id, job.started_at, agent.observed_ip, agent.link_type,
    !agent.current_lease_id || !agent.observed_ip]);
  await client.query(`INSERT INTO eval_job_network_events
    (job_id, agent_id, lease_id, started_at, seq, event, source, occurred_at, offset_ms, tags, changed)
    VALUES ($1, $2, $3, $4, 0, 'initial', 'core', $4, 0, $5, '[]')`,
  [job.id, job.eval_agent_id, agent.current_lease_id, job.started_at, JSON.stringify(networkEventTags(job.tags))]);
}

/** Observations, event acknowledgement and eligibility commit together. */
export async function recordAgentNetworkEvents(opts: {
  agentId: number; leaseId: string | null; ip?: string; report?: NetworkReport;
  finalJobId?: number;
  client?: PoolClient;
}): Promise<NetworkAck | undefined> {
  if (opts.report && !opts.leaseId) throw new NetworkReportError(409, "Network event reporting requires a current lease");
  const client = opts.client ?? await pool.connect();
  try {
    if (!opts.client) await client.query("BEGIN");
    const jobId = opts.finalJobId ?? opts.report?.jobId;
    if (opts.report && opts.finalJobId !== undefined && opts.report.jobId !== opts.finalJobId) {
      throw new NetworkReportError(409, "Network report does not match this execution");
    }
    const { rows } = await client.query(`SELECT j.*, s.lease_id AS network_lease_id,
      s.observed_ip AS network_observed_ip, s.link_type AS network_link_type,
      s.first_seq, s.last_seq, s.monitoring_gap, s.finalized, a.link_type AS current_link_type
      FROM eval_jobs j JOIN eval_job_network_state s ON s.job_id = j.id
      JOIN eval_agents a ON a.id = j.eval_agent_id
      WHERE j.eval_agent_id = $1 AND s.agent_id = $1
        AND s.lease_id IS NOT DISTINCT FROM $2 AND a.current_lease_id IS NOT DISTINCT FROM $2
        AND s.started_at = j.started_at AND j.kind = 'eval'
        AND (($3::int IS NULL AND j.status = 'running') OR j.id = $3)
      FOR UPDATE OF j, s`, [opts.agentId, opts.leaseId, jobId ?? null]);
    if (opts.report && rows.length !== 1) throw new NetworkReportError(409, "Network report does not match this execution");
    let ack: NetworkAck | undefined;
    for (const job of rows) {
      const report = opts.report;
      if (report && new Date(report.startedAt).getTime() !== new Date(job.started_at).getTime()) {
        throw new NetworkReportError(409, "Network report does not match this execution");
      }
      if (job.status !== "running" || job.finalized) {
        // A lost completion response may retry. A terminal run can acknowledge
        // existing events, but cannot acquire a different history after finalization.
        if (report) {
          for (const event of report.events) await assertStoredEvent(client, job, event);
          ack = { jobId: job.id, startedAt: new Date(job.started_at).toISOString(), ackedEventSeqs: report.events.map((event) => event.seq) };
        }
        continue;
      }
      const baseline = networkEventTags(job.tags);
      let changed = !!job.network_changed;
      let monitoringGap = !!job.monitoring_gap;
      const currentIp = opts.ip ? normalizeIp(opts.ip) : null;
      const previousIp = job.network_observed_ip ? normalizeIp(job.network_observed_ip) : null;
      const link = (LINK_VALUES as readonly string[]).includes(job.current_link_type) ? job.current_link_type : null;
      const changedKeys: string[] = [];
      if (currentIp && previousIp && currentIp !== previousIp) changedKeys.push("egress");
      if (link && job.network_link_type && link !== job.network_link_type) changedKeys.push("link");
      if (changedKeys.length > 0) {
        changed = true;
        const asn = currentIp ? lookupAsn(currentIp) : null;
        const tags: NetworkEventTags = { ...baseline, link, isp: asn ? ispFromAsn(asn.asn, asn.org) ?? null : null, access: null };
        await client.query(`INSERT INTO eval_job_network_events
          (job_id, agent_id, lease_id, started_at, event, source, occurred_at, offset_ms, tags, changed)
          VALUES ($1, $2, $3, $4, 'network_change', 'core', $5, $6, $7, $8)`,
        [job.id, opts.agentId, opts.leaseId, job.started_at, new Date(),
          Math.max(0, Date.now() - new Date(job.started_at).getTime()), JSON.stringify(tags), JSON.stringify(changedKeys)]);
      }
      if (report) {
        if (job.first_seq !== null && Number(job.first_seq) !== report.firstSeq) throw new NetworkReportError(409, "Network sequence changed within an execution");
        changed ||= report.networkChanged || report.events.some((event) => event.event === "network_change");
        monitoringGap ||= !report.continuous || report.events.some((event) => event.event === "monitoring_gap");
        for (const event of report.events) {
          // Delayed delivery does not prove which public ISP carried an earlier
          // observation. Keep it explicitly unknown; Core observations above
          // describe the verified egress at receipt time, without exposing IPs.
          const tags = { ...baseline, link: event.tags.link, isp: null, access: null };
          const inserted = await client.query(`INSERT INTO eval_job_network_events
            (job_id, agent_id, lease_id, started_at, seq, event, source, occurred_at, offset_ms, tags, changed)
            VALUES ($1, $2, $3, $4, $5, $6, 'agent', $7, $8, $9, $10)
            ON CONFLICT (job_id, agent_id, lease_id, started_at, source, seq) DO NOTHING RETURNING id`,
          [job.id, opts.agentId, opts.leaseId, job.started_at, event.seq, event.event,
            new Date(event.timestamp), event.offsetMs, JSON.stringify(tags), JSON.stringify(event.changed)]);
          if (!inserted.rows.length) {
            await assertStoredEvent(client, job, event);
          }
        }
        ack = { jobId: job.id, startedAt: report.startedAt, ackedEventSeqs: report.events.map((event) => event.seq) };
      }
      const lastSeq = Math.max(Number(job.last_seq ?? 0), report?.lastSeq ?? 0);
      const firstSeq = job.first_seq === null ? report?.firstSeq ?? null : Number(job.first_seq);
      const { rows: [counts] } = await client.query(`SELECT
        count(*) FILTER (WHERE source = 'agent' AND seq BETWEEN $3 AND $4)::int AS received,
        count(*) FILTER (WHERE event = 'network_change')::int AS changes,
        count(*) FILTER (WHERE source = 'agent' AND seq = $3 AND event = 'monitoring_start')::int AS starts,
        count(*) FILTER (WHERE source = 'agent' AND seq = $4 AND event = 'monitoring_end')::int AS ends
        FROM eval_job_network_events WHERE job_id = $1 AND started_at = $2`, [job.id, job.started_at, firstSeq, lastSeq]);
      const final = opts.finalJobId === job.id;
      const complete = final && report && firstSeq !== null && !monitoringGap
        && report.lastSeq === lastSeq && lastSeq >= firstSeq && counts.received === lastSeq - firstSeq + 1
        && counts.starts === 1 && counts.ends === 1;
      const monitoring = final ? (complete ? "complete" : "incomplete") : monitoringGap ? "incomplete" : report ? "monitoring" : job.network_monitoring;
      await client.query(`UPDATE eval_jobs SET network_changed = network_changed OR $2,
        network_monitoring = $3, network_change_count = GREATEST(network_change_count, $4) WHERE id = $1`,
      [job.id, changed, monitoring, Math.max(counts.changes, report?.changeCount ?? 0)]);
      await client.query(`UPDATE eval_job_network_state SET observed_ip = COALESCE($2, observed_ip),
        link_type = COALESCE($3, link_type), first_seq = $4, last_seq = $5,
        monitoring_gap = $6, finalized = $7 WHERE job_id = $1`,
      [job.id, currentIp, link, firstSeq, lastSeq, monitoringGap, final]);
    }
    if (!opts.client) await client.query("COMMIT");
    return ack;
  } catch (error) {
    if (!opts.client) await client.query("ROLLBACK");
    throw error;
  } finally { if (!opts.client) client.release(); }
}

export async function getJobNetworkHistory(job: EvalJob, cursor = 0): Promise<NetworkHistory> {
  const { rows } = await pool.query(`SELECT id, event, source, seq, occurred_at, offset_ms, tags, changed
    FROM eval_job_network_events WHERE job_id = $1 AND started_at = $2 AND id > $3 ORDER BY id LIMIT 101`,
  [job.id, job.startedAt, cursor]);
  const events = rows.slice(0, 100).map((row) => ({
    id: row.id, event: row.event, source: row.source, seq: row.seq === null ? null : Number(row.seq),
    timestamp: new Date(row.occurred_at).getTime(), offsetMs: row.offset_ms, tags: row.tags, changed: row.changed,
  }));
  return { events, nextCursor: rows.length > 100 ? events.at(-1)!.id : null,
    networkChanged: job.networkChanged, monitoring: job.networkMonitoring, changeCount: job.networkChangeCount };
}
