import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  BROWSER_RESPONSE_LIMIT, browserCommandSchema, browserFrameSchema,
  type BrowserCommand, type BrowserResponse, type BrowserFrame, type BrowserOperation,
} from "../shared/browser-assistance";

/** Private, non-logging JSONL connection. Responses and frames share one reader. */
export class BrowserControlConnection {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, { socket: net.Socket; resolve: (value: BrowserResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private destroyed = false;
  private latestFrame: BrowserFrame | null = null;
  private identity: { session_id: string; browser_generation: string; lease_id: string } | null = null;
  constructor(private socketPath: string) {}

  private connect(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error("Browser connection closed"));
    if (this.socket && !this.socket.destroyed && !this.socket.connecting) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.setEncoding("utf8");
      this.socket = socket;
      let buffer = "";
      const timer = setTimeout(() => socket.destroy(), 3000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end; (end = buffer.indexOf("\n")) >= 0;) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line) > BROWSER_RESPONSE_LIMIT) { socket.destroy(); return; }
          try {
            const value = JSON.parse(line);
            if (value.version !== 1) continue;
            if (value.type === "event" && value.event === "viewer.frame") {
              const frame = browserFrameSchema.safeParse(value);
              if (frame.success) this.latestFrame = frame.data;
            } else if (value.type === "response" && typeof value.id === "string" && typeof value.ok === "boolean") {
              const pending = this.pending.get(value.id);
              if (pending?.socket === socket) { clearTimeout(pending.timer); this.pending.delete(value.id); pending.resolve(value); }
            }
          } catch { socket.destroy(); return; }
        }
        if (Buffer.byteLength(buffer) > BROWSER_RESPONSE_LIMIT) socket.destroy();
      });
      socket.on("error", () => { reject(new Error("Browser connection unavailable")); });
      socket.on("close", () => {
        clearTimeout(timer);
        reject(new Error("Browser connection unavailable"));
        if (this.socket === socket) { this.socket = null; this.latestFrame = null; }
        for (const [id, item] of this.pending) if (item.socket === socket) {
          clearTimeout(item.timer); item.reject(new Error("Browser connection lost; command outcome may be unknown")); this.pending.delete(id);
        }
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async request(request: BrowserCommand): Promise<BrowserResponse> {
    const command = browserCommandSchema.parse(request);
    await this.connect();
    const socket = this.socket;
    if (this.destroyed || !socket || socket.destroyed) throw new Error("Browser connection closed");
    if (this.pending.size >= 8 || this.pending.has(command.id)) throw new Error("Browser command already pending");
    const response = await new Promise<BrowserResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error("Browser command outcome unknown; do not repeat it"));
      }, 10_000);
      this.pending.set(command.id, { socket, resolve, reject, timer });
      socket.write(JSON.stringify(command) + "\n", (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(command.id); reject(new Error("Browser connection lost")); }
      });
    });
    if (command.command === "viewer.open" && response.ok && typeof response.result?.lease_id === "string"
      && command.session_id && command.browser_generation) {
      this.identity = { session_id: command.session_id, browser_generation: command.browser_generation, lease_id: response.result.lease_id };
    }
    return response;
  }

  frame(): BrowserFrame | null { const frame = this.latestFrame; this.latestFrame = null; return frame; }
  async close(): Promise<void> {
    if (this.identity && this.socket && !this.socket.destroyed) {
      const { lease_id, ...identity } = this.identity;
      await this.request({ version: 1, id: randomUUID(), command: "viewer.close", ...identity,
        params: { lease_id, immediate: true } }).catch(() => undefined);
    }
    this.destroy();
  }
  destroy(): void { this.destroyed = true; this.latestFrame = null; this.identity = null; this.socket?.destroy(); }
}

export class LocalBrowserSessions {
  observation: "read_only" | "interactive" | null = null;
  private viewers = new Map<string, { client: BrowserControlConnection; touched: number }>();
  private inspector: BrowserControlConnection;
  private cleanup: ReturnType<typeof setInterval>;
  private destroyed = false;
  constructor(socketPath: string) {
    this.inspector = new BrowserControlConnection(socketPath);
    this.cleanup = setInterval(() => {
      for (const [id, item] of this.viewers) if (Date.now() - item.touched > 6000) {
        this.viewers.delete(id); void item.client.close();
      }
    }, 1000);
    this.cleanup.unref();
    this.socketPath = socketPath;
  }
  private socketPath: string;
  async handle(operation: BrowserOperation): Promise<unknown> {
    if (this.destroyed) throw new Error("Browser execution ended");
    if (operation.action === "status") return this.inspector.request({ version: 1, id: randomUUID(), command: "session.status" });
    if (operation.action === "close") {
      const item = this.viewers.get(operation.viewerId);
      this.viewers.delete(operation.viewerId);
      await item?.client.close(); return { closed: true };
    }
    if (operation.action === "frame") return this.viewers.get(operation.viewerId)?.client.frame() ?? null;
    if (!operation.request) throw new Error("Browser command required");
    let item = this.viewers.get(operation.viewerId);
    if (!item) {
      if (this.viewers.size >= 1) throw new Error("A browser viewer is already connected");
      item = { client: new BrowserControlConnection(this.socketPath), touched: Date.now() };
      this.viewers.set(operation.viewerId, item);
    }
    item.touched = Date.now();
    const response = await item.client.request(operation.request);
    if (response.ok && operation.request.command === "viewer.open") this.observation ??= "read_only";
    if (response.ok && operation.request.command === "viewer.take_control") this.observation = "interactive";
    return response;
  }
  destroy(): void {
    this.destroyed = true;
    clearInterval(this.cleanup); this.inspector.destroy();
    for (const item of this.viewers.values()) item.client.destroy();
    this.viewers.clear();
  }
}
