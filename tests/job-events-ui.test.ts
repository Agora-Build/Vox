import { describe, expect, it } from "vitest";
import { eventCategory, eventPresentation, formatEventOffset, hostEventSummary, isInitialMonitoringGap, networkEventSummary } from "../client/src/lib/job-events";
import type { NetworkHistory, NetworkHistoryEvent } from "../shared/network-events";

const event = (type: NetworkHistoryEvent["event"], seq = 1): NetworkHistoryEvent => ({ id: seq, seq, event: type, timestamp: Date.now(), offsetMs: 0, source: "agent", tags: { link: null }, changed: [] });
const history = (overrides: Partial<NetworkHistory> = {}): NetworkHistory => ({ events: [], nextCursor: null, monitoring: "unknown", networkChanged: false, changeCount: 0, ...overrides });

describe("generalized Events presentation", () => {
  it("distinguishes an unavailable initial sample from an interrupted connection", () => {
    const start = event("monitoring_start"), gap = event("monitoring_gap", 2);
    expect(isInitialMonitoringGap(gap, [start, gap])).toBe(true);
    expect(eventPresentation(gap, true)).toMatchObject({ label: "Network tracking unavailable" });
    expect(eventPresentation(gap, true).description).toContain("does not mean the Internet was disconnected");
    expect(isInitialMonitoringGap({ ...gap, seq: 10 }, [start, gap])).toBe(false);
    expect(eventPresentation(gap, false).label).toBe("Network tracking interrupted");
  });
  it("uses Initial and End without claiming the evaluation was stopped", () => {
    expect(eventPresentation(event("initial"), false).label).toBe("Initial");
    expect(eventPresentation(event("monitoring_end"), false)).toMatchObject({ label: "End", description: expect.stringContaining("recording network events") });
  });
  it("does not promise a completed incomplete run can be verified later", () => {
    expect(networkEventSummary(history({ monitoring: "incomplete" }), false, true)).toMatchObject({
      label: "Network monitoring incomplete", status: "Excluded from Strict", description: expect.stringContaining("cannot be reconstructed later"),
    });
  });
  it("does not let CPU warnings relabel network stability or current Strict eligibility", () => {
    expect(networkEventSummary(history({ monitoring: "complete", resources: { ruleVersion: 1, monitoring: "complete", highUsage: true, rapidRise: false } }), false, false))
      .toMatchObject({ label: "No network changes detected", status: "Eligible for Strict" });
  });
  it("never labels missing host coverage healthy", () => {
    expect(hostEventSummary(null).label).toBe("Host resources not monitored");
    expect(hostEventSummary({ ruleVersion: 1, monitoring: "incomplete", highUsage: false, rapidRise: false }).description).toContain("not evidence of healthy");
  });
  it("keeps high-usage observations visible even when later coverage is incomplete", () => {
    expect(hostEventSummary({ ruleVersion: 1, monitoring: "incomplete", highUsage: true, rapidRise: false }))
      .toMatchObject({ label: "High host usage recorded", description: expect.stringContaining("also incomplete") });
  });
  it("distinguishes percentage-point rises from relative growth and high usage", () => {
    const rise = { ...event("host_rise"), data: { ruleVersion: 1 as const, metric: "memory" as const, previousPercent: 40, valuePercent: 65, windowMs: 300000, risePoints: 20 } };
    expect(eventCategory(rise)).toBe("memory");
    expect(eventPresentation(rise, false)).toMatchObject({ label: "Host memory rising quickly", description: "40% to 65% in 5 minutes (+25 percentage points)." });
    expect(hostEventSummary({ ruleVersion: 1, monitoring: "complete", highUsage: false, rapidRise: true }).description).toContain("not a high-usage warning");
  });
  it.each([[0, "+0.0s"], [1588200, "+26m 28s"], [3601000, "+1h 00m 01s"]])("formats offsets %s", (offset, expected) => {
    expect(formatEventOffset(offset)).toBe(expected);
  });
});
