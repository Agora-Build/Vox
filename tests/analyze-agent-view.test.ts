import { describe, it, expect } from "vitest";
import { forAgentJobList } from "../server/analyze";

// Tools → Analyze: pending analyses are listed to every agent that could take
// one (public ones included). Before an agent claims it, it learns only what
// it needs to decide — not the uploader's file name or where it's stored.
describe("forAgentJobList", () => {
  it("leaves out an analysis's upload details", () => {
    const job = { id: 7, kind: "analyze", transport: "web", snapshot: { provider: { id: "p" }, analyze: { fileName: "my call with Dr. Smith.wav", s3Key: "vox-analyze/2/x.wav", sha256: "ab" } } };
    const listed = forAgentJobList(job as any) as any;
    expect(listed).toMatchObject({ id: 7, kind: "analyze", transport: "web" });
    expect(JSON.stringify(listed)).not.toContain("Dr. Smith");
    expect(JSON.stringify(listed)).not.toContain("vox-analyze/");
  });
  it("leaves an eval job as it is", () => {
    const job = { id: 8, kind: "eval", snapshot: { evalFlow: { name: "x" } } };
    expect(forAgentJobList(job as any)).toBe(job);
  });
});
