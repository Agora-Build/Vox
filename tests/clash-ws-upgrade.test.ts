import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "http";
import { connect } from "net";
import { setupClashWebSocket } from "../server/clash-ws";

// Which WebSocket upgrades the Clash handler refuses. It used to destroy
// every non-Clash upgrade — including Vite's dev /vite-hmr, so hot reload
// never connected locally. /vite-hmr may pass only outside production: in
// production nothing else handles it, and an upgrade nobody handles would
// stay open forever (a free way to pile up connections).

let server: Server | undefined;
const sockets = new Set<import("net").Socket>();
const savedEnv = process.env.NODE_ENV;
afterEach(async () => {
  process.env.NODE_ENV = savedEnv;
  // An upgrade nobody handles holds its socket open indefinitely — which is
  // why production must refuse /vite-hmr — so close() alone would wait forever.
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** "closed" if the server destroys the socket within `ms`, else "open". */
async function upgradeOutcome(path: string, ms = 500): Promise<"closed" | "open"> {
  server = createServer();
  server.on("connection", (s) => sockets.add(s));
  setupClashWebSocket(server);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    const timer = setTimeout(() => { sock.destroy(); resolve("open"); }, ms);
    sock.on("close", () => { clearTimeout(timer); resolve("closed"); });
    sock.on("error", () => {});
  });
}

describe("clash-ws upgrade handling", () => {
  it("production: /vite-hmr is refused like any unknown path", async () => {
    process.env.NODE_ENV = "production";
    expect(await upgradeOutcome("/vite-hmr")).toBe("closed");
  });

  it("dev: /vite-hmr is left for Vite's own listener", async () => {
    process.env.NODE_ENV = "development";
    expect(await upgradeOutcome("/vite-hmr")).toBe("open");
  });

  it("any other unknown path is refused, in either mode", async () => {
    process.env.NODE_ENV = "development";
    expect(await upgradeOutcome("/not-a-socket")).toBe("closed");
  });
});
