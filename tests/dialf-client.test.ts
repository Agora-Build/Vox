import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { DialfClient, probeDialf, REQUIRED_DIALF_STEPS } from "../vox_eval_agentd/dialf-client";

// Fake dialfd: a Unix-socket line-JSON server scripted per-op (DialF
// docs/INTEGRATION.md contract shapes, v0.3.8).

type OpHandler = (req: any) => any | null; // null = no response (timeout test)

function fakeDialfd(handlers: Record<string, OpHandler>): { server: net.Server; sockPath: string } {
  const sockPath = path.join(os.tmpdir(), `fake-dialfd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`);
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (c) => {
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let req: any;
        try { req = JSON.parse(line); } catch {
          conn.write(JSON.stringify({ id: "", done: true, ok: false, error: "parse error" }) + "\n");
          continue;
        }
        const h = handlers[req.op];
        if (!h) {
          // Unknown op arrives uncorrelatable per contract §3.
          conn.write(JSON.stringify({ id: "", done: true, ok: false, error: `unknown variant \`${req.op}\`` }) + "\n");
          continue;
        }
        const out = h(req);
        if (out === null) continue; // deliberately no response
        conn.write(JSON.stringify({ id: req.id, done: true, ok: true, data: out }) + "\n");
      }
    });
  });
  server.listen(sockPath);
  return { server, sockPath };
}

const HEALTHY: Record<string, OpHandler> = {
  "server.info": () => ({ version: "0.3.8", ten_vad: "1.0", config_path: "/x" }),
  "server.manifest": () => ({
    executor: "dialf", version: "0.3.8", spec_version: "0.1",
    steps: [...REQUIRED_DIALF_STEPS, "sms.send", "control.wait", "control.log"],
    inline_orchestrated: ["sms.send"], extensions: [],
  }),
  "devices.list": () => [{ id: "phone-1", name: "Pixel", addr: "10.0.0.9", last_seen_ms: 100 }],
};

describe("DialfClient", () => {
  let rig: { server: net.Server; sockPath: string };

  beforeAll(() => { rig = fakeDialfd(HEALTHY); });
  afterAll(() => { rig.server.close(); });

  it("one-shot call returns data; ok:false becomes an Error, connection stays usable", async () => {
    const rig2 = fakeDialfd({
      ...HEALTHY,
      "call.dial": () => { throw new Error("unused"); },
    });
    const c = new DialfClient(rig2.sockPath);
    await c.connect();
    const info = (await c.call("server.info")) as any;
    expect(info.version).toBe("0.3.8");
    // Unknown op → ok:false with id:"" — must reject, not hang or disconnect.
    await expect(c.call("job.status")).rejects.toThrow(/unknown variant/);
    // The connection is still usable after the failure (contract §3).
    const again = (await c.call("server.info")) as any;
    expect(again.version).toBe("0.3.8");
    c.close();
    rig2.server.close();
  });

  it("times out per-call when the daemon never answers", async () => {
    const rig3 = fakeDialfd({ "server.info": () => null });
    const c = new DialfClient(rig3.sockPath, 200);
    await c.connect();
    await expect(c.call("server.info")).rejects.toThrow(/timed out/);
    c.close();
    rig3.server.close();
  });
});

describe("resolveDialfSocketPath", () => {
  it("VOX_DIALF_SOCKET env override wins over all resolution", async () => {
    const { resolveDialfSocketPath } = await import("../vox_eval_agentd/dialf-client");
    expect(resolveDialfSocketPath({ VOX_DIALF_SOCKET: "/x/dialfd.sock" } as any)).toBe("/x/dialfd.sock");
  });
});

describe("probeDialf", () => {
  it("healthy daemon probes ok; SIM number read from sims.list (default SIM preferred)", async () => {
    const rig = fakeDialfd({
      ...HEALTHY,
      "sims.list": () => ({
        sims: [
          { slot: 0, sub_id: 1, number: "+15550001111", is_default: false },
          { slot: 1, sub_id: 2, number: "+15550009999", is_default: true },
        ],
      }),
    });
    const out = await probeDialf(rig.sockPath);
    expect(out).toEqual({ ok: true, version: "0.3.8", phoneNumber: "+15550009999" });
    rig.server.close();
  });

  it("probe still ok when no SIM exposes a number (carriers often don't provision it)", async () => {
    const rig = fakeDialfd({ ...HEALTHY, "sims.list": () => ({ sims: [{ slot: 0, sub_id: 1 }] }) });
    const out = await probeDialf(rig.sockPath);
    expect(out.ok).toBe(true);
    expect(out.phoneNumber).toBeUndefined();
    rig.server.close();
  });

  it("fails closed on: unreachable socket, stub VAD, wrong spec, missing step, no phone", async () => {
    const un = await probeDialf(path.join(os.tmpdir(), "definitely-missing.sock"));
    expect(un.ok).toBe(false);

    const stub = fakeDialfd({ ...HEALTHY, "server.info": () => ({ version: "0.3.8", ten_vad: "stub" }) });
    expect((await probeDialf(stub.sockPath)).reason).toContain("ten_vad=stub");
    stub.server.close();

    const spec = fakeDialfd({ ...HEALTHY, "server.manifest": () => ({ spec_version: "0.2", steps: [...REQUIRED_DIALF_STEPS] }) });
    expect((await probeDialf(spec.sockPath)).reason).toContain("spec 0.2");
    spec.server.close();

    const missing = fakeDialfd({
      ...HEALTHY,
      "server.manifest": () => ({ spec_version: "0.1", steps: ["call.dial", "audio.play"] }),
    });
    expect((await probeDialf(missing.sockPath)).reason).toContain("missing steps");
    missing.server.close();

    const nophone = fakeDialfd({ ...HEALTHY, "devices.list": () => [] });
    expect((await probeDialf(nophone.sockPath)).reason).toBe("no phone connected");
    nophone.server.close();
  });
});
