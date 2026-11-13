import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserControlConnection, LocalBrowserSessions } from "../vox_eval_agentd/browser-control";
import { browserCommandSchema, supportsBrowserAssistance, type BrowserCommand } from "../shared/browser-assistance";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const command = (name: BrowserCommand["command"], params?: Record<string, unknown>): BrowserCommand => ({
  version: 1, id: randomUUID(), command: name, session_id: "session", browser_generation: "generation", ...(params ? { params } : {}),
});
const frame = { version: 1, type: "event", event: "viewer.frame", session_id: "session", browser_generation: "generation",
  page_id: "page", document_epoch: 1, lease_id: "lease", data: "YQ==", metadata: { deviceWidth: 800, deviceHeight: 600 } };

async function fixture(handle: (request: BrowserCommand, socket: net.Socket) => void) {
  const directory = await mkdtemp(join(tmpdir(), "vox-control-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8"); let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let index; (index = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        handle(JSON.parse(line), socket);
      }
    });
  });
  const socketPath = join(directory, "control.sock");
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return socketPath;
}
const respond = (socket: net.Socket, request: BrowserCommand, result: unknown) => socket.write(JSON.stringify({ version: 1, type: "response", id: request.id, ok: true, result }) + "\n");

describe("private browser protocol adapter", () => {
  it("demultiplexes a frame before open's response and keeps only the latest frame", async () => {
    const socketPath = await fixture((request, socket) => {
      socket.write(JSON.stringify(frame) + "\n" + JSON.stringify({ ...frame, data: "Yg==" }) + "\n");
      respond(socket, request, { lease_id: "lease" });
    });
    const client = new BrowserControlConnection(socketPath); cleanups.push(() => client.destroy());
    expect((await client.request(command("viewer.open", { page_id: "page", document_epoch: 1 }))).ok).toBe(true);
    expect(client.frame()?.data).toBe("Yg==");
    expect(client.frame()).toBeNull();
  });

  it("decodes split UTF-8 responses and matches interleaved replies by ID", async () => {
    const pending: { request: BrowserCommand; socket: net.Socket }[] = [];
    const socketPath = await fixture((request, socket) => {
      pending.push({ request, socket });
      if (pending.length !== 2) return;
      for (const entry of pending.reverse()) {
        const line = Buffer.from(JSON.stringify({ version: 1, type: "response", id: entry.request.id, ok: true, result: { label: "café" } }) + "\n");
        const split = line.indexOf(Buffer.from("é")) + 1;
        entry.socket.write(line.subarray(0, split)); entry.socket.write(line.subarray(split));
      }
    });
    const client = new BrowserControlConnection(socketPath); cleanups.push(() => client.destroy());
    const responses = await Promise.all([client.request(command("session.status")), client.request(command("session.status"))]);
    expect(responses.map((response) => response.result?.label)).toEqual(["café", "café"]);
  });

  it("does not retry a mutation when the socket closes before the acknowledgement", async () => {
    let count = 0;
    const socketPath = await fixture((_request, socket) => { count++; socket.destroy(); });
    const client = new BrowserControlConnection(socketPath); cleanups.push(() => client.destroy());
    await expect(client.request(command("viewer.input", { input: { type: "text", text: "one-time code" } }))).rejects.toThrow(/lost|unavailable/);
    expect(count).toBe(1);
  });

  it("explicit close sends immediate close and a destroyed connection cannot reconnect", async () => {
    const seen: BrowserCommand[] = [];
    const socketPath = await fixture((request, socket) => { seen.push(request); respond(socket, request, request.command === "viewer.open" ? { lease_id: "lease" } : {}); });
    const client = new BrowserControlConnection(socketPath); cleanups.push(() => client.destroy());
    await client.request(command("viewer.open")); await client.close();
    expect(seen[1]).toMatchObject({ command: "viewer.close", params: { lease_id: "lease", immediate: true } });
    await expect(client.request(command("session.status"))).rejects.toThrow(/closed/);
  });

  it("does not admit oversized commands or arbitrary script execution", () => {
    expect(browserCommandSchema.safeParse(command("viewer.input", { text: "x".repeat(17000) })).success).toBe(false);
    expect(browserCommandSchema.safeParse({ ...command("session.status"), command: "Runtime.evaluate" }).success).toBe(false);
    expect(browserCommandSchema.safeParse({ ...command("session.status"), token: "extra" }).success).toBe(false);
  });

  it("isolates one viewer, does not capture on status, and records only actual assistance", async () => {
    const seen: BrowserCommand[] = [];
    const socketPath = await fixture((request, socket) => { seen.push(request); respond(socket, request, { lease_id: "lease" }); });
    const local = new LocalBrowserSessions(socketPath); cleanups.push(() => local.destroy());
    const viewerId = randomUUID();
    await local.handle({ action: "status", viewerId });
    expect(seen.map((entry) => entry.command)).toEqual(["session.status"]); expect(local.observation).toBeNull();
    await local.handle({ action: "command", viewerId, request: command("viewer.open") });
    expect(local.observation).toBe("read_only");
    await expect(local.handle({ action: "command", viewerId: randomUUID(), request: command("viewer.open") })).rejects.toThrow(/already/);
    await local.handle({ action: "command", viewerId, request: command("viewer.take_control") });
    expect(local.observation).toBe("interactive");
    await local.handle({ action: "close", viewerId });
    expect(seen.at(-1)).toMatchObject({ command: "viewer.close", params: { immediate: true } });
    local.destroy();
    await expect(local.handle({ action: "status", viewerId })).rejects.toThrow(/ended/);
  });

  it("expires a viewer when its end user stops sending commands; frame reads do not renew it", async () => {
    const seen: BrowserCommand[] = [];
    const socketPath = await fixture((request, socket) => { seen.push(request); respond(socket, request, { lease_id: "lease" }); });
    const local = new LocalBrowserSessions(socketPath); cleanups.push(() => local.destroy());
    const viewerId = randomUUID();
    await local.handle({ action: "command", viewerId, request: command("viewer.open") });
    const reader = setInterval(() => { void local.handle({ action: "frame", viewerId }); }, 100);
    cleanups.push(() => clearInterval(reader));
    await new Promise((resolve) => setTimeout(resolve, 7200));
    expect(seen.at(-1)).toMatchObject({ command: "viewer.close", params: { immediate: true } });
  });

  it.each([["v0.4.3", false], ["v0.4.4", true], ["0.5.0", true], ["1.0.0", true], ["unknown", false]])("gates engine %s", (version, expected) => {
    expect(supportsBrowserAssistance(version as string)).toBe(expected);
  });
});
