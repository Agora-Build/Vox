import { describe, expect, it } from "vitest";
import { publicLineLookup } from "../shared/tags";
import { publicEvalFlow, publicEvalJob } from "../server/network-response";
import { buildJobSnapshot } from "../server/storage";

describe("network metadata response privacy", () => {
  const lookup = { value: "twilio", carrierName: "Twilio", lineType: "voip", lookedUpAt: "2026-11-05T00:00:00.000Z",
    number: "...1234", numberHash: "server-only-equality-token" };
  it("strips only the equality token and does not mutate the internal lookup", () => {
    expect(publicLineLookup(lookup)).toEqual({ value: "twilio", carrierName: "Twilio", lineType: "voip", lookedUpAt: lookup.lookedUpAt, number: "...1234" });
    expect(lookup.numberHash).toBe("server-only-equality-token");
    expect(publicLineLookup(undefined)).toBeNull();
    expect(publicEvalFlow({ lineLookup: null })).toEqual({ lineLookup: null });
  });
  it("sanitizes legacy snapshots without changing their frozen data at rest", () => {
    const job = { snapshot: { evalFlow: { lineLookup: lookup } } } as any;
    expect(publicEvalJob(job).snapshot.evalFlow.lineLookup).not.toHaveProperty("numberHash");
    expect(job.snapshot.evalFlow.lineLookup).toBe(lookup);
  });
  it("never copies the equality token into a new frozen snapshot", () => {
    const snapshot = buildJobSnapshot({ name: "phone", config: {}, visibility: "public", isMainline: true, ownerId: 1, lineLookup: lookup } as any, null, null, "premium");
    expect(snapshot.evalFlow!.lineLookup).toMatchObject({ value: "twilio", number: "...1234" });
    expect(snapshot.evalFlow!.lineLookup).not.toHaveProperty("numberHash");
    expect(lookup.numberHash).toBe("server-only-equality-token");
  });
});
