/**
 * vox-rest-broker — trusted HTTP execution sidecar (design 2026-09-21 §5).
 *
 * The `restful` twin of the auth-session broker, minus everything hard: no
 * browser, no aeval, no audio — it executes one templated HTTP request per
 * call and returns {status, bodyExcerpt}. Internal network ONLY. Registers
 * itself with Core on startup (declaring brokerType "restful") and heartbeats;
 * the /execute bearer secret is the per-broker mintSecret handed back by Core
 * at registration, held only in memory.
 *
 * Deployment note (design §5): environment requirements are solved by broker
 * PLACEMENT — a target needing a fixed egress IP or an isolated network gets
 * this sidecar deployed into that network, zero code change.
 *
 * The sidecar performs NO redaction (it cannot know which values are secrets —
 * Core redacts with its own copies); it only bounds: response read cap, excerpt
 * cap, per-request timeout, SSRF target guards, manual redirects.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";

// ---- SSRF target guard ------------------------------------------------------

const PRIVATE_V4 = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^0\./,
];

/** Throws on a target URL this broker must not fetch. Exported for tests. */
export function assertSafeTarget(raw: string): void {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`invalid target url`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`unsupported scheme: ${url.protocol}`);
  }
  if (process.env.REST_BROKER_ALLOW_PRIVATE === "1") return; // dev/test escape hatch
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1") {
    throw new Error("target host not allowed: loopback");
  }
  if (PRIVATE_V4.some((re) => re.test(host))) {
    throw new Error("target host not allowed: private/reserved address");
  }
  if (host.includes(":")) {
    // IPv6 literal (URL keeps brackets off hostname); allow only global-looking
    // addresses — reject loopback/link-local/unique-local explicitly.
    const h = host.replace(/^\[|\]$/g, "");
    if (h === "::1" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) {
      throw new Error("target host not allowed: private/reserved address");
    }
  }
}

// ---- execute handler --------------------------------------------------------

export interface ExecRequestBody {
  method?: unknown; url?: unknown; headers?: unknown;
  body?: unknown; timeoutMs?: unknown;
}

const RESPONSE_READ_CAP = 64 * 1024;
const EXCERPT_CAP = 2048;
const TIMEOUT_CAP_MS = 120_000;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export async function executeTarget(
  body: ExecRequestBody,
  fetchImpl: typeof fetch = fetch,
): Promise<{ code: number; payload: Record<string, unknown> }> {
  if (typeof body.method !== "string" || !METHODS.has(body.method) || typeof body.url !== "string") {
    return { code: 400, payload: { error: "invalid request: method/url" } };
  }
  try {
    assertSafeTarget(body.url);
  } catch (e) {
    return { code: 400, payload: { error: e instanceof Error ? e.message : "unsafe target" } };
  }
  const headers: Record<string, string> = {};
  if (body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  }
  const timeoutMs = Math.min(
    typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : 30_000,
    TIMEOUT_CAP_MS,
  );
  let payloadBody: string | undefined;
  if (body.body !== undefined && body.method !== "GET") {
    payloadBody = typeof body.body === "string" ? body.body : JSON.stringify(body.body);
    if (headers["content-type"] === undefined && headers["Content-Type"] === undefined) {
      headers["content-type"] = "application/json";
    }
  }
  try {
    const res = await fetchImpl(body.url, {
      method: body.method,
      headers,
      body: payloadBody,
      redirect: "manual", // 3xx is a RESULT, never followed (SSRF via redirect)
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Cap what we READ, then cap the excerpt again.
    let text = "";
    try { text = (await res.text()).slice(0, RESPONSE_READ_CAP); } catch { /* body unreadable */ }
    return { code: 200, payload: { status: res.status, bodyExcerpt: text.slice(0, EXCERPT_CAP) } };
  } catch (e) {
    // Sanitized: no stack; the message may name the host (Core-side redaction
    // still applies before anything reaches an agent).
    const msg = e instanceof Error ? e.message.slice(0, 300) : "fetch failed";
    return { code: 502, payload: { error: `target fetch failed: ${msg}` } };
  }
}

// ---- HTTP server ------------------------------------------------------------

export function createRestBrokerServer(getSecret: () => string | undefined, fetchImpl: typeof fetch = fetch): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const respond = (code: number, payload: Record<string, unknown>) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== "POST" || req.url !== "/execute") return respond(404, { error: "not found" });
    const secret = getSecret();
    const auth = req.headers.authorization || "";
    if (!secret || auth !== `Bearer ${secret}`) return respond(401, { error: "unauthorized" });
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 256 * 1024) req.destroy(); });
    req.on("end", async () => {
      let body: ExecRequestBody;
      try { body = JSON.parse(raw); } catch { return respond(400, { error: "invalid JSON" }); }
      const out = await executeTarget(body, fetchImpl);
      respond(out.code, out.payload);
    });
  });
}

// ---- registration client (mirrors auth-session-broker.ts) -------------------

let state: { brokerId: number; leaseId: string; mintSecret: string } | null = null;
const CORE_URL = process.env.VOX_CORE_URL;
const REG_TOKEN = process.env.BROKER_REG_TOKEN;
const ADVERTISE_URL = process.env.BROKER_ADVERTISE_URL;
const BROKER_NAME = process.env.BROKER_NAME || "rest-broker";
const HEARTBEAT_MS = 60_000;

async function register(): Promise<void> {
  const res = await fetch(`${CORE_URL}/api/brokers/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${REG_TOKEN}` },
    body: JSON.stringify({ name: BROKER_NAME, brokerType: "restful", url: ADVERTISE_URL }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  state = await res.json();
}

export async function heartbeat(): Promise<void> {
  try {
    if (!state) { await register(); return; }
    const res = await fetch(`${CORE_URL}/api/brokers/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${REG_TOKEN}` },
      body: JSON.stringify({ brokerId: state.brokerId, leaseId: state.leaseId, state: "idle" }),
    }).catch(() => null);
    if (!res || !res.ok) return;
    const body = await res.json().catch(() => ({}));
    if (body.reregister || body.superseded) { state = null; await register(); }
  } catch (err) {
    console.error("[RestBroker] heartbeat error:", err instanceof Error ? err.message : err);
  }
}

// Entrypoint (skipped under vitest import)
if (process.argv[1] && process.argv[1].endsWith("rest-broker.js")) {
  const port = parseInt(process.env.BROKER_PORT || "8300", 10);
  const server = createRestBrokerServer(() => state?.mintSecret);
  (async () => {
    try {
      await register();
    } catch (err) {
      console.error("[RestBroker] registration failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    server.listen(port, "0.0.0.0", () => console.log(`[RestBroker] REST broker listening on :${port}`));
    setInterval(heartbeat, HEARTBEAT_MS);
  })();
}
