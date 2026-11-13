import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { Agent } from "undici";
import { internalFetch } from "../server/internal-fetch";

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, Agent: vi.fn(function (options: ConstructorParameters<typeof actual.Agent>[0]) { return new actual.Agent(options); }) };
});

afterEach(() => { vi.restoreAllMocks(); });

describe("internal HTTP deadlines", () => {
  it("disables hidden transport deadlines and reuses a dedicated dispatcher", async () => {
    const received: (RequestInit & { dispatcher?: unknown })[] = [];
    const network = vi.fn(async (_url: unknown, init?: RequestInit) => {
      received.push(init!);
      return new Response("ok");
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    for (const budget of [615_000, 616_000]) {
      await internalFetch("http://core.internal/mint", {
        method: "POST", redirect: "manual", body: "{}",
      }, budget, network as typeof fetch);
      expect(timeout).toHaveBeenLastCalledWith(budget);
    }
    expect(Agent).toHaveBeenCalledWith({ headersTimeout: 0, bodyTimeout: 0 });
    expect(received[0].dispatcher).toBeDefined();
    expect(received[1].dispatcher).toBe(received[0].dispatcher);
    expect(received[0]).toMatchObject({ method: "POST", redirect: "manual", body: "{}", signal: expect.any(AbortSignal) });
  });

  it("still aborts a real stalled HTTP request at the explicit deadline without retrying", async () => {
    let requests = 0;
    const server = createServer(() => { requests++; });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      await expect(internalFetch(`http://127.0.0.1:${port}`, { redirect: "manual" }, 250)).rejects.toMatchObject({ name: "TimeoutError" });
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
