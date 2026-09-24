/**
 * DialF control-socket client (DialF ≥ v0.3.8, docs/INTEGRATION.md is the
 * contract; design 2026-09-21 §6). Line-delimited JSON over a Unix socket:
 * one request object per line, responses matched on the terminal frame
 * (`done: true`) rather than strictly on `id` — a line the daemon cannot parse
 * (including an op this build lacks) comes back with `id: ""` (contract §3).
 *
 * Connection model (contract §4): requests on ONE connection are handled
 * strictly in sequence, and `job.run` blocks until the job ends — callers set
 * the read timeout from the job's own worst case, never a default. Cancels
 * must come from a SECOND connection.
 *
 * Node builtins only — this file is bundled into the daemon image unchanged.
 */
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---- socket resolution (contract §2: config → per-user → system) -----------

export function resolveDialfSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  // Explicit override first — REQUIRED when the daemon runs in Docker with
  // dialfd on the host (vox-upgrade.sh bind-mounts the socket and sets this).
  if (env.VOX_DIALF_SOCKET) return env.VOX_DIALF_SOCKET;
  const cfg = path.join(os.homedir(), '.config', 'dialf', 'config.yaml');
  try {
    if (fs.existsSync(cfg)) {
      // `control_socket` is a top-level scalar — a line scan avoids a YAML dep
      // (same approach as the contract's reference client).
      const m = fs.readFileSync(cfg, 'utf-8').match(/^control_socket:\s*"?(.+?)"?\s*$/m);
      if (m) return m[1].startsWith('~') ? path.join(os.homedir(), m[1].slice(1)) : m[1];
    }
  } catch { /* unreadable config → fall through */ }
  const user = env.XDG_RUNTIME_DIR
    ? path.join(env.XDG_RUNTIME_DIR, 'dialfd.sock')
    : `/tmp/dialfd-${typeof process.getuid === 'function' ? process.getuid() : 0}.sock`;
  if (fs.existsSync(user)) return user;
  const system = os.platform() === 'darwin' ? '/var/run/dialfd.sock' : '/run/dialf/dialfd.sock';
  return fs.existsSync(system) ? system : user;
}

// ---- client -----------------------------------------------------------------

interface DialfFrame {
  id?: string;
  done?: boolean;
  ok?: boolean;
  error?: string;
  data?: unknown;
}

export class DialfClient {
  private sock: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;

  constructor(private socketPath: string, private defaultTimeoutMs = 15_000) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(this.socketPath);
      s.once('connect', () => { this.sock = s; resolve(); });
      s.once('error', reject);
    });
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }

  /**
   * One-shot op: send, then read frames until the terminal one (`done: true`).
   * `ok: false` is thrown as an Error (a response, not a disconnection —
   * contract §3). `timeoutMs` MUST be sized to the op: a blocking `job.run`
   * needs the sum of its step timeouts plus slack (contract §4).
   */
  async call(op: string, fields: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    if (!this.sock) throw new Error('dialf client not connected');
    const sock = this.sock;
    const id = String(this.nextId++);
    sock.write(JSON.stringify({ id, op, ...fields }) + '\n');
    const deadline = timeoutMs ?? this.defaultTimeoutMs;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`dialf ${op}: timed out after ${deadline}ms`));
      }, deadline);
      const onData = (chunk: Buffer) => {
        this.buffer += chunk.toString('utf-8');
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          let frame: DialfFrame;
          try { frame = JSON.parse(line); } catch { continue; }
          // Terminal frame on the connection — matched loosely on id because an
          // unparseable request echoes id:"" (contract §3 wrinkle).
          if (frame.done) {
            cleanup();
            if (frame.ok) resolve(frame.data);
            else reject(new Error(`dialf ${op}: ${frame.error ?? 'unknown error'}`));
            return;
          }
          // done:false interim events (only autoanswer.serve) — ignored here;
          // serve consumers use their own connection and frames() semantics.
        }
      };
      const onErr = (err: Error) => { cleanup(); reject(err); };
      const cleanup = () => {
        clearTimeout(timer);
        sock.off('data', onData);
        sock.off('error', onErr);
      };
      sock.on('data', onData);
      sock.on('error', onErr);
    });
  }
}

// ---- probe (capability gate; design §6 + contract §6) -----------------------

/** Steps the phone eval flow dispatches — checked against server.manifest. */
export const REQUIRED_DIALF_STEPS = [
  'call.dial', 'call.wait_answered', 'call.answer', 'call.hangup',
  'audio.play', 'audio.wait_for_speech', 'audio.wait_for_speech_start',
] as const;

export interface DialfProbe {
  ok: boolean;
  reason?: string;
  version?: string;
  /** Our SIM's own number (for ${phoneNumber} injection in trigger mode), read
   * from DialF's sims.list — the default SIM's number, else the first SIM that
   * has one. Undefined when the carrier didn't provision it on any SIM. */
  phoneNumber?: string;
}

interface SimInfo { slot?: number; sub_id?: number; number?: string; is_default?: boolean }

export async function probeDialf(
  socketPath: string = resolveDialfSocketPath(),
): Promise<DialfProbe> {
  const client = new DialfClient(socketPath, 5_000);
  try {
    await client.connect();
  } catch {
    return { ok: false, reason: 'dialfd socket unreachable' };
  }
  try {
    const info = (await client.call('server.info')) as { version?: string; ten_vad?: string };
    if (info?.ten_vad === 'stub') {
      return { ok: false, reason: 'dialfd built without VAD (ten_vad=stub)', version: info.version };
    }
    const manifest = (await client.call('server.manifest')) as { spec_version?: string; steps?: string[] };
    if (manifest?.spec_version !== '0.1') {
      return { ok: false, reason: `dialfd speaks spec ${manifest?.spec_version}, expected 0.1`, version: info?.version };
    }
    const missing = REQUIRED_DIALF_STEPS.filter((s) => !(manifest.steps ?? []).includes(s));
    if (missing.length > 0) {
      return { ok: false, reason: `dialfd missing steps: ${missing.join(', ')}`, version: info?.version };
    }
    const devices = (await client.call('devices.list')) as unknown[];
    if (!Array.isArray(devices) || devices.length === 0) {
      return { ok: false, reason: 'no phone connected', version: info?.version };
    }
    // SIM's own number from DialF (best-effort — a snapshot op; absence is not
    // a probe failure, the number only matters for the trigger mode).
    let phoneNumber: string | undefined;
    try {
      const sims = (await client.call('sims.list')) as { sims?: SimInfo[] };
      const entries = Array.isArray(sims?.sims) ? sims.sims : [];
      phoneNumber = (entries.find((s) => s.is_default && s.number) ?? entries.find((s) => s.number))?.number;
    } catch { /* older builds / phone slow to answer — leave undefined */ }
    return { ok: true, version: info?.version, phoneNumber };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'probe failed' };
  } finally {
    client.close();
  }
}
