import type { Pool } from "pg";
import type { WorkerSpec } from "@vox/plugin-sdk";

export function advisoryKey(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

export class WorkerHost {
  private specs: Array<{ pluginId: string; spec: WorkerSpec }> = [];
  private timers: ReturnType<typeof setInterval>[] = [];

  register(pluginId: string, spec: WorkerSpec): void {
    this.specs.push({ pluginId, spec });
  }

  startAll(pool: Pool): void {
    for (const { pluginId, spec } of this.specs) {
      const tick = async (): Promise<void> => {
        try {
          if (spec.singleton) {
            const key = advisoryKey(`${pluginId}:${spec.id}`);
            // Session-scoped advisory lock: pg_try_advisory_lock and
            // pg_advisory_unlock MUST run on the same connection, so hold one
            // dedicated client for the whole tick. (pool.query() grabs a
            // different client per call, which would leak the lock and
            // permanently block the singleton after its first tick.)
            const client = await pool.connect();
            try {
              const { rows } = await client.query(`SELECT pg_try_advisory_lock($1) AS ok`, [key]);
              if (!rows[0]?.ok) return;
              try {
                await spec.run();
              } finally {
                await client.query(`SELECT pg_advisory_unlock($1)`, [key]);
              }
            } finally {
              client.release();
            }
          } else {
            await spec.run();
          }
        } catch (err) {
          console.error(`[plugin:${pluginId}] worker ${spec.id} failed`, err);
        }
      };
      this.timers.push(setInterval(tick, spec.intervalMs));
    }
  }

  async stopAll(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const { spec } of this.specs) {
      if (spec.onShutdown) await spec.onShutdown();
    }
  }
}
