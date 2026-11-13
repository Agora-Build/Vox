import WebSocket from "ws";
import { browserOperationSchema, BROWSER_RESPONSE_LIMIT, type BrowserOperation } from "../shared/browser-assistance";

/** Outbound only: no health/debug port is exposed to reach the browser. */
export class ReverseBrowserBridge {
  private ws: WebSocket | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private config: {
    serverUrl: string; token: string; leaseId: () => string | null;
    handle: (execution: { jobId: number; startedAt: string }, operation: BrowserOperation | { action: "cancel" }) => Promise<unknown>;
  }) {}
  connect(): void {
    if (this.stopped || this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    const leaseId = this.config.leaseId();
    if (!leaseId) return;
    const url = new URL("/ws/eval-browser", this.config.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.config.token}`, "x-vox-agent-lease": leaseId },
      maxPayload: 32 * 1024, handshakeTimeout: 5000,
    });
    this.ws = ws;
    let inFlight = 0;
    ws.on("message", (data) => {
      if (inFlight >= 12) { ws.close(1008); return; }
      let message: { id: string; execution: { jobId: number; startedAt: string }; operation: BrowserOperation | { action: "cancel" } };
      try {
        message = JSON.parse(data.toString());
        if (typeof message.id !== "string" || message.id.length > 128
          || !Number.isInteger(message.execution?.jobId) || typeof message.execution.startedAt !== "string") throw new Error();
        if (message.operation?.action !== "cancel") message.operation = browserOperationSchema.parse(message.operation);
      } catch { ws.close(1008); return; }
      inFlight++;
      void this.config.handle(message.execution, message.operation).then((result) => {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < BROWSER_RESPONSE_LIMIT) ws.send(JSON.stringify({ id: message.id, ok: true, result }));
      }).catch(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, ok: false }));
      }).finally(() => { inFlight--; });
    });
    ws.on("error", () => undefined);
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) { this.reconnect = setTimeout(() => this.connect(), 3000); this.reconnect.unref(); }
    });
  }
  stop(): void { this.stopped = true; if (this.reconnect) clearTimeout(this.reconnect); this.ws?.close(); }
}
