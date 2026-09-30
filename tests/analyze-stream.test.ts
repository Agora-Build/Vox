import { describe, it, expect } from "vitest";
import { createServer } from "http";
import { PassThrough } from "stream";
import { pipeToResponse } from "../server/analyze";

// The uploader's storage can fail midway through a download (it's theirs).
// The response must then end — pipe() left it open forever.
describe("pipeToResponse", () => {
  it("ends the response when the source fails midway", async () => {
    const source = new PassThrough();
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Length": "1000" });
      pipeToResponse(source, res, "test file");
      source.write(Buffer.alloc(10));
      setTimeout(() => source.destroy(new Error("aborted")), 50);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    try {
      const outcome = await Promise.race([
        fetch(`http://127.0.0.1:${port}/`).then((r) => r.arrayBuffer()).then(() => "ended", () => "ended"),
        new Promise((r) => setTimeout(() => r("hung"), 3000)),
      ]);
      expect(outcome).toBe("ended");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
