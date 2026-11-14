import { describe, expect, it } from "vitest";
import { browserStatusSchema, type BrowserStatus } from "../shared/browser-assistance";
import { browserReadinessMessage } from "../client/src/lib/browser-readiness";

const status: BrowserStatus = {
  session_id: "session", browser_generation: "generation", capabilities: [], pages: [],
  viewing: true, controlling: false, next_sequence: 1,
  assistance: { wait_id: "wait", kind: "authentication", state: "held", page_id: "evaluation", remaining_seconds: 120 },
};

describe("browser readiness feedback", () => {
  it("accepts older engines without the new optional fields", () => {
    expect(browserStatusSchema.parse(status)).toEqual(status);
  });

  it("ignores unknown past outcomes without losing the active wait or viewer status", () => {
    const parsed = browserStatusSchema.parse({ ...status, last_assistance: { ...status.assistance, state: "future_state" } });
    expect(parsed.last_assistance).toBeNull();
    expect(parsed.assistance).toEqual(status.assistance);
    expect(browserReadinessMessage(parsed)).toContain("Evaluation paused");
  });

  it("still rejects unknown active states instead of weakening control validation", () => {
    expect(browserStatusSchema.safeParse({ ...status, assistance: { ...status.assistance, state: "future_state" } }).success).toBe(false);
  });

  it("retains the engine's active and final readiness reasons", () => {
    const checking = { ...status.assistance!, state: "checking" as const, reason: "selector_absent" as const, last_check_reason: "selector_absent" as const };
    const parsed = browserStatusSchema.parse({ ...status, assistance: checking, last_assistance: { ...checking, state: "expired", reason: "assistance_expired" } });
    expect(parsed.assistance).toEqual(checking);
    expect(parsed.last_assistance?.state).toBe("expired");
    expect(browserReadinessMessage(parsed)).toContain("required page element is not visible");
    expect(browserReadinessMessage(parsed)).toContain("retrying");
  });

  it("does not display unknown reason text, URLs, or credentials from the engine", () => {
    const parsed = browserStatusSchema.parse({ ...status, assistance: { ...status.assistance, state: "checking", reason: "https://provider.example/verify?token=secret", last_check_reason: "password=secret" } });
    expect(parsed.assistance?.reason).toBeNull();
    expect(browserReadinessMessage(parsed)).not.toContain("secret");
    expect(browserReadinessMessage(parsed)).toContain("Checking the evaluation tab");
  });

  it("does not claim an acknowledged check means the evaluation resumed", () => {
    expect(browserReadinessMessage({ ...status, assistance: { ...status.assistance!, state: "checking", reason: "checking" } })).not.toContain("resumed");
  });

  it("uses the last outcome after the active hold ends", () => {
    const ended: BrowserStatus = { ...status, assistance: null, last_assistance: { ...status.assistance!, state: "ready", reason: "ready" } };
    expect(browserReadinessMessage(ended)).toContain("Readiness confirmed");
    expect(browserReadinessMessage({ ...ended, last_assistance: { ...ended.last_assistance!, state: "expired", reason: "assistance_expired", last_check_reason: "still_on_login" } })).toContain("still on the login page");
    expect(browserReadinessMessage({ ...ended, last_assistance: { ...ended.last_assistance!, state: "expired" } })).not.toContain("resumed");
  });

  it("prefers the current wait to a previous successful outcome", () => {
    expect(browserReadinessMessage({ ...status, last_assistance: { ...status.assistance!, state: "ready" } })).toContain("Evaluation paused");
  });

  it.each([
    ["navigation_timeout", "took too long to load"], ["wrong_target", "not reached the required page"],
    ["check_timeout", "readiness check timed out"], ["check_failed", "could not finish"],
    ["condition_not_met", "condition is not met"], ["browser_unavailable", "no longer available"],
  ] as const)("explains %s using fixed, safe copy", (reason, expected) => {
    expect(browserReadinessMessage({ ...status, assistance: { ...status.assistance!, reason } })).toContain(expected);
  });
});
