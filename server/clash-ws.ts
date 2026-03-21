import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";

interface SpectatorConnection {
  ws: WebSocket;
  matchId: number;
}

interface RunnerConnection {
  ws: WebSocket;
  matchId: number;
}

const spectators = new Map<number, Set<SpectatorConnection>>();
const runners = new Map<number, RunnerConnection>();

export function setupClashWebSocket(httpServer: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);

    const runnerMatch = url.pathname.match(/^\/ws\/clash-runner\/(\d+)$/);
    if (runnerMatch) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        const matchId = parseInt(runnerMatch[1]);
        runners.set(matchId, { ws, matchId });
        ws.on("message", (data) => {
          const conns = spectators.get(matchId);
          if (conns) {
            const msg = data.toString();
            conns.forEach((conn) => {
              if (conn.ws.readyState === WebSocket.OPEN) {
                conn.ws.send(msg);
              }
            });
          }
        });
        ws.on("close", () => runners.delete(matchId));
      });
      return;
    }

    const spectatorMatch = url.pathname.match(/^\/ws\/clash\/(\d+)$/);
    if (spectatorMatch) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        const matchId = parseInt(spectatorMatch[1]);
        if (!spectators.has(matchId)) {
          spectators.set(matchId, new Set());
        }
        const conn: SpectatorConnection = { ws, matchId };
        spectators.get(matchId)!.add(conn);

        broadcastToSpectators(matchId, {
          type: "spectatorCount",
          count: spectators.get(matchId)!.size,
        });

        ws.on("close", () => {
          spectators.get(matchId)?.delete(conn);
          if (spectators.get(matchId)?.size === 0) {
            spectators.delete(matchId);
          } else {
            broadcastToSpectators(matchId, {
              type: "spectatorCount",
              count: spectators.get(matchId)?.size || 0,
            });
          }
        });
      });
      return;
    }

    // Not a clash WebSocket path — don't handle (let other upgrade handlers or destroy)
    socket.destroy();
  });
}

export function broadcastToSpectators(matchId: number, data: unknown): void {
  const conns = spectators.get(matchId);
  if (!conns) return;
  const msg = JSON.stringify(data);
  conns.forEach((conn) => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(msg);
    }
  });
}

export function sendToRunner(matchId: number, data: unknown): void {
  const conn = runners.get(matchId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify(data));
  }
}

export function getSpectatorCount(matchId: number): number {
  return spectators.get(matchId)?.size || 0;
}
