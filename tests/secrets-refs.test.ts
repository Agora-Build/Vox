import { describe, it, expect } from "vitest";
import { collectSecretRefs } from "../shared/secrets";

describe("collectSecretRefs", () => {
  it("collects names from a string config", () => {
    expect(collectSecretRefs(["email: ${secrets.MY_EMAIL}\npw: ${secrets.MY_PW}"]))
      .toEqual(new Set(["MY_EMAIL", "MY_PW"]));
  });
  it("collects names from a nested object config", () => {
    const cfg = { stepsPrefix: "x: ${secrets.A}", scenario: { params: { key: "${secrets.B}" } } };
    expect(collectSecretRefs([cfg])).toEqual(new Set(["A", "B"]));
  });
  it("dedupes across multiple configs and ignores null", () => {
    expect(collectSecretRefs([null, "${secrets.A}", { v: "${secrets.A}" }]))
      .toEqual(new Set(["A"]));
  });
  it("returns empty for configs with no refs", () => {
    expect(collectSecretRefs([{ a: 1 }, "plain"])).toEqual(new Set());
  });
});
