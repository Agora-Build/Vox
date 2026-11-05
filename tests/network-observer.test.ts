import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NetworkObserver } from "../vox_eval_agentd/network-observer";

describe("container host network observations", () => {
  let dir: string, observer: NetworkObserver;
  const event = (seq: number, link = "wifi") => ({ seq, link, fingerprint: (seq % 2 ? "a" : "b").repeat(64), timestamp: Date.now() });
  function status(events = [event(1)], overrides: Record<string, unknown> = {}) {
    const latest = events.at(-1)!;
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ version: 1, seq: latest.seq, monitor: "host-session", gapCount: 0,
      available: true, timestamp: Date.now(), link: latest.link, fingerprint: latest.fingerprint, events, ...overrides }));
  }
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "vox-net-observer-")); vi.stubEnv("VOX_NETWORK_STATUS_FILE", path.join(dir, "status.json")); observer = new NetworkObserver(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  it("starts with the latest state, not old pre-claim transitions", () => {
    status([event(1), event(2, "cellular")]);
    expect(observer.sample()).toMatchObject({ gap: false, observations: [{ link: "cellular" }] });
  });
  it("replays buffered transitions exactly once, including A to B to A", () => {
    status(); observer.sample();
    status([event(1), event(2, "cellular"), event(3)]);
    expect(observer.sample().observations.map((o) => o.link)).toEqual(["cellular", "wifi"]);
    expect(observer.sample().observations.map((o) => o.link)).toEqual(["wifi"]);
  });
  it("an expired or crashed host sampler is not evidence of stability", () => {
    expect(observer.sample()).toEqual({ observations: [], gap: true });
    status(); expect(observer.sample().gap).toBe(false);
    fs.unlinkSync(path.join(dir, "status.json"));
    expect(observer.sample()).toEqual({ observations: [], gap: true });
  });
  it("rejects stale, unavailable, malformed and oversized status files", () => {
    status([event(1)], { timestamp: Date.now() - 6000 }); expect(observer.sample().gap).toBe(true);
    status([event(1)], { available: false }); expect(observer.sample().gap).toBe(true);
    fs.writeFileSync(path.join(dir, "status.json"), "{"); expect(observer.sample().gap).toBe(true);
    fs.writeFileSync(path.join(dir, "status.json"), " ".repeat(140000)); expect(observer.sample().gap).toBe(true);
  });
  it("detects missing transitions, sampler restarts and missed monitoring gaps", () => {
    status(); observer.sample();
    status([event(3)]); expect(observer.sample().gap).toBe(true);
    status([event(4)], { gapCount: 1 }); expect(observer.sample().gap).toBe(true);
    status([event(1)], { monitor: "new-host-session" }); expect(observer.sample().gap).toBe(true);
  });
  it("rejects raw/private values in the fingerprint and unsupported link values", () => {
    status([event(1)], { fingerprint: "192.168.1.1" }); expect(observer.sample().gap).toBe(true);
    status([event(1)], { link: "something-else" }); expect(observer.sample().gap).toBe(true);
  });
});
