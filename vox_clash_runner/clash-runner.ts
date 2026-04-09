// clash-runner.ts — Main orchestrator for Clash Runner container (warm pool model).
//
// Lifecycle:
// 1. Start PipeWire + create virtual sinks (once at container boot)
// 2. Register with Vox server (POST /api/clash-runner/register)
// 3. Start heartbeat loop (POST /api/clash-runner/heartbeat every 15s)
// 4. Poll for assignment (GET /api/clash-runner/assignment every 5s)
// 5. When assigned:
//    a. Get match config + secrets + agora config
//    b. Launch browsers, run setup steps
//    c. Call moderator endpoints for briefing phases
//    d. Cross-wire audio, start observer + broadcaster
//    e. Open WebSocket to server for live metrics
//    f. Wait for duration
//    g. Stop everything, compute metrics
//    h. Report complete (POST /api/clash-runner/complete)
// 6. Return to step 4 (poll for next assignment)

import { execSync } from "child_process";
import * as path from "path";
import WebSocket from "ws";
import { launchBrowserAgent, closeBrowserAgent, type AgentConfig, type BrowserAgent } from "./browser-agent.js";
import { crossWireAudio, startObserver, computeMetrics } from "./audio/observer.js";

const VOX_SERVER = process.env.VOX_SERVER || "http://localhost:5000";
const RUNNER_TOKEN = process.env.RUNNER_TOKEN;
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/app/output";

if (!RUNNER_TOKEN) {
  console.error("[ClashRunner] RUNNER_TOKEN required");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${RUNNER_TOKEN}`,
};

async function apiCall(method: string, endpoint: string, body?: unknown): Promise<any> {
  const res = await fetch(`${VOX_SERVER}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${endpoint} failed (${res.status}): ${text}`);
  }
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Heartbeat loop (runs independently in parallel with main loop)
function startHeartbeat(): void {
  setInterval(async () => {
    try {
      await apiCall("POST", "/api/clash-runner/heartbeat");
    } catch (err) {
      console.error("[ClashRunner] Heartbeat failed:", err);
    }
  }, 15000);
}

// Main loop
async function main() {
  // Step 1: Setup PipeWire (once at container boot)
  console.log("[ClashRunner] Setting up PipeWire...");
  execSync("bash /app/audio/pipewire-setup.sh", { stdio: "inherit" });

  // Step 2: Register with Vox server
  console.log("[ClashRunner] Registering...");
  const reg = await apiCall("POST", "/api/clash-runner/register", {
    runnerId: process.env.HOSTNAME || "local",
  });
  console.log(`[ClashRunner] Registered as runner #${reg.id}, state: ${reg.state}`);

  // Step 3: Start heartbeat loop
  startHeartbeat();

  // Step 4: Poll for assignments forever
  console.log("[ClashRunner] Polling for assignments...");
  while (true) {
    try {
      const assignment = await apiCall("GET", "/api/clash-runner/assignment");

      if (!assignment.assigned) {
        await sleep(5000);
        continue;
      }

      console.log(`[ClashRunner] Assigned match #${assignment.match.id}: "${assignment.match.topic}"`);
      await executeMatch(assignment);
      console.log("[ClashRunner] Match complete, returning to pool.");
    } catch (err) {
      console.error("[ClashRunner] Error in poll loop:", err);
      await sleep(5000);
    }
  }
}

async function executeMatch(config: any) {
  let agentA: BrowserAgent | null = null;
  let agentB: BrowserAgent | null = null;
  let observer: Awaited<ReturnType<typeof startObserver>> | null = null;
  let metricsWs: WebSocket | null = null;
  const matchId = config.match.id;

  try {
    // Fetch secrets for this match (on-demand, not bundled in assignment)
    console.log("[ClashRunner] Fetching secrets...");
    let secrets: Record<string, string> = {};
    try {
      secrets = await apiCall("GET", `/api/clash-runner/secrets?matchId=${matchId}`);
      console.log(`[ClashRunner] Got ${Object.keys(secrets).length} secret(s)`);
    } catch (err) {
      console.warn("[ClashRunner] Failed to fetch secrets — proceeding without:", err instanceof Error ? err.message : err);
    }

    // Moderator announcement
    try {
      await apiCall("POST", "/api/clash/moderator/start", { matchId, phase: "announce" });
      await sleep(8000);
    } catch {
      // Moderator optional
    }

    // Launch Browser A
    console.log("[ClashRunner] Launching Browser A...");
    agentA = await launchBrowserAgent(
      config.agentA,
      "Virtual_Sink_A",
      "Virtual_Sink_B.monitor",
      secrets,
    );

    // Brief Agent A via moderator
    try {
      await apiCall("POST", "/api/clash/moderator/announce", { matchId, phase: "brief_a" });
      await sleep(5000);
    } catch {
      // Moderator optional
    }

    // Launch Browser B
    console.log("[ClashRunner] Launching Browser B...");
    agentB = await launchBrowserAgent(
      config.agentB,
      "Virtual_Sink_B",
      "Virtual_Sink_A.monitor",
      secrets,
    );

    // Brief Agent B via moderator
    try {
      await apiCall("POST", "/api/clash/moderator/announce", { matchId, phase: "brief_b" });
      await sleep(5000);
    } catch {
      // Moderator optional
    }

    // Cross-wire audio
    console.log("[ClashRunner] Cross-wiring audio...");
    await sleep(2000);
    crossWireAudio();

    // Start observer (recording + broadcast)
    const outputDir = path.join(OUTPUT_DIR, `clash-${matchId}`);
    observer = await startObserver(
      outputDir,
      config.agora
        ? {
            appId: config.agora.appId,
            channelName: config.agora.channelName,
            tokenA: config.agora.broadcasterTokenA,
            tokenB: config.agora.broadcasterTokenB,
            uidA: config.agora.broadcasterUidA,
            uidB: config.agora.broadcasterUidB,
          }
        : undefined,
    );

    // Moderator "begin!"
    try {
      await apiCall("POST", "/api/clash/moderator/announce", { matchId, phase: "start" });
    } catch {
      // Moderator optional
    }

    // Open WebSocket for live metrics
    try {
      const wsUrl = VOX_SERVER.replace(/^http/, "ws") + `/ws/clash-runner/${matchId}`;
      metricsWs = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${RUNNER_TOKEN}` },
      } as any);
      const metricsInterval = setInterval(() => {
        if (metricsWs?.readyState === WebSocket.OPEN) {
          metricsWs.send(JSON.stringify({ type: "metrics", matchId, timestamp: Date.now() }));
        }
      }, 500);
      metricsWs.onclose = () => clearInterval(metricsInterval);
    } catch (err) {
      console.warn("[ClashRunner] WebSocket metrics unavailable:", err);
    }

    console.log(`[ClashRunner] Match #${matchId} live for ${config.match.maxDurationSeconds}s`);
    await sleep(config.match.maxDurationSeconds * 1000);

    // Stop observer and close browsers
    console.log("[ClashRunner] Match time expired. Stopping...");
    const recordingPath = await observer.stopAll();
    observer = null;

    if (metricsWs) {
      metricsWs.close();
      metricsWs = null;
    }

    await closeBrowserAgent(agentA);
    agentA = null;
    await closeBrowserAgent(agentB);
    agentB = null;

    // Compute metrics
    const { metricsA, metricsB } = computeMetrics(recordingPath, config.match.maxDurationSeconds);

    // Moderator end
    try {
      await apiCall("POST", "/api/clash/moderator/announce", { matchId, phase: "end" });
      await sleep(5000);
      await apiCall("POST", "/api/clash/moderator/stop", { matchId });
    } catch {
      // Moderator optional
    }

    // Report complete
    await apiCall("POST", "/api/clash-runner/complete", {
      matchId,
      metricsA,
      metricsB,
      recordingUrl: recordingPath,
      durationSeconds: config.match.maxDurationSeconds,
    });
  } catch (err) {
    console.error("[ClashRunner] Match error:", err);

    // Clean up
    if (observer) {
      try { await observer.stopAll(); } catch {}
    }
    if (metricsWs) {
      try { metricsWs.close(); } catch {}
    }
    if (agentA) await closeBrowserAgent(agentA);
    if (agentB) await closeBrowserAgent(agentB);

    // Stop moderator on error
    try { await apiCall("POST", "/api/clash/moderator/stop", { matchId }); } catch {}

    // Report failure
    try {
      await apiCall("POST", "/api/clash-runner/complete", {
        matchId,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (reportErr) {
      console.error("[ClashRunner] Failed to report error:", reportErr);
    }
  }
}

main().catch((err) => {
  console.error("[ClashRunner] Fatal:", err);
  process.exit(1);
});
