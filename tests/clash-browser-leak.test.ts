import { describe, it, expect, vi, afterEach } from "vitest";
import net from "net";
import { chromium, type Browser } from "playwright-core";
import { launchBrowserAgent } from "../vox_clash_runner/browser-agent";

// The clash runner launches one Chromium per agent, then loads the agent's
// page and runs its setup steps. When either failed, launchBrowserAgent threw
// without closing the browser it had just launched — the caller never got it,
// so nothing ever closed it. Long-running runners on the dev host had piled up
// over a hundred Chromium processes this way (#244: they held root's inotify
// instances, and the audio pipeline test went silent).

async function closedPort(): Promise<number> {
  const s = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const { port } = s.address() as net.AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

describe("a browser agent that fails to start is closed, not leaked", () => {
  const launched: Browser[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const b of launched.splice(0)) await b.close().catch(() => {});
  });

  it("the agent page doesn't load: the launched browser is closed before the error surfaces", async () => {
    const realLaunch = chromium.launch.bind(chromium);
    vi.spyOn(chromium, "launch").mockImplementation(async (opts) => {
      const b = await realLaunch(opts);
      launched.push(b);
      return b;
    });
    const url = `http://127.0.0.1:${await closedPort()}/agent`;
    await expect(launchBrowserAgent(
      { name: "A", agentUrl: url, setupSteps: [] } as never, "Sink_A_Out", "Mic_A", {},
    )).rejects.toThrow(/ERR_CONNECTION_REFUSED|net::/);
    expect(launched).toHaveLength(1);
    expect(launched[0].isConnected()).toBe(false); // closed — no orphaned Chromium
  }, 60_000);
});
