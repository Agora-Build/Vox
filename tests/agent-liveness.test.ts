import { describe, it, expect } from "vitest";
import { isStaleOfflineAgent } from "../server/agent-liveness";

describe("isStaleOfflineAgent", () => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  const withinDay = new Date("2026-08-21T06:00:00.000Z"); // 18h ago
  const overDay = new Date("2026-08-20T00:00:00.000Z"); // 48h ago
  const exactlyDay = new Date("2026-08-21T00:00:00.000Z"); // exactly 24h ago

  it("offline agent not seen in over 24h is stale", () => {
    expect(isStaleOfflineAgent({ state: "offline", lastSeenAt: overDay }, now)).toBe(true);
  });

  it("offline agent with null lastSeenAt is stale", () => {
    expect(isStaleOfflineAgent({ state: "offline", lastSeenAt: null }, now)).toBe(true);
  });

  it("offline agent seen within 24h is NOT stale", () => {
    expect(isStaleOfflineAgent({ state: "offline", lastSeenAt: withinDay }, now)).toBe(false);
  });

  it("offline agent seen exactly 24h ago is NOT stale (boundary excluded)", () => {
    expect(isStaleOfflineAgent({ state: "offline", lastSeenAt: exactlyDay }, now)).toBe(false);
  });

  it("idle agent is never stale regardless of lastSeenAt", () => {
    expect(isStaleOfflineAgent({ state: "idle", lastSeenAt: overDay }, now)).toBe(false);
    expect(isStaleOfflineAgent({ state: "idle", lastSeenAt: null }, now)).toBe(false);
  });

  it("occupied agent is never stale", () => {
    expect(isStaleOfflineAgent({ state: "occupied", lastSeenAt: overDay }, now)).toBe(false);
  });

  it("accepts an ISO string lastSeenAt (over 24h → stale)", () => {
    expect(isStaleOfflineAgent({ state: "offline", lastSeenAt: overDay.toISOString() }, now)).toBe(true);
  });

  it("honors a custom threshold", () => {
    // 18h ago with a 12h threshold → stale
    expect(isStaleOfflineAgent({ state: "offline", lastSeenAt: withinDay }, now, 12 * 60 * 60 * 1000)).toBe(true);
  });
});
