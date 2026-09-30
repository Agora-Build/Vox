import { describe, it, expect } from "vitest";
import { forAgentJobList } from "../server/analyze";

// Tools → Analyze: pending analyses are listed to every agent that could take
// one (public ones included). Before an agent claims it, it learns only what
// it needs to decide — not the uploader's file name or where it's stored.
describe("forAgentJobList", () => {
  it("gives an analysis as the bare minimum the agent runs it with", () => {
    const job = {
      id: 7, kind: "analyze", transport: "phone", status: "pending", createdBy: 42, creatorOrgId: 9,
      createdAt: new Date(), retryCount: 1, config: {},
      snapshot: { provider: { id: "p", name: "Agora" }, creatorPlan: "premium", analyze: { fileName: "my call with Dr. Smith.wav", s3Key: "vox-analyze/42/x.wav", sha256: "ab" } },
    };
    const listed = forAgentJobList(job as any) as Record<string, unknown>;
    expect(listed).toEqual({ id: 7, kind: "analyze", transport: "phone", status: "pending", config: {} });
  });
  it("leaves an eval job as it is", () => {
    const job = { id: 8, kind: "eval", snapshot: { evalFlow: { name: "x" } } };
    expect(forAgentJobList(job as any)).toBe(job);
  });
});
