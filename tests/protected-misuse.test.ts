import { describe, it, expect } from "vitest";
import { findBrokeredMisuse, defaultBrokerTypeForName, resolveBrokerType } from "../server/auth-session";
import { isAuthFieldName } from "../shared/secrets";

describe("findBrokeredMisuse", () => {
  const pair = { emailSecret: "LOGIN_EMAIL", passwordSecret: "LOGIN_PW" };
  it("allows protected secrets that are exactly the login pair", () => {
    const classified = [
      { name: "LOGIN_EMAIL", brokerType: "auth-session" },
      { name: "LOGIN_PW", brokerType: "auth-session" },
    ];
    expect(findBrokeredMisuse(classified, pair)).toEqual([]);
  });
  it("flags a protected secret referenced outside the login pair", () => {
    const classified = [
      { name: "LOGIN_EMAIL", brokerType: "auth-session" },
      { name: "LOGIN_PW", brokerType: "auth-session" },
      { name: "API_TOKEN", brokerType: "auth-session" },
    ];
    expect(findBrokeredMisuse(classified, pair)).toEqual(["API_TOKEN"]);
  });
  it("flags any protected ref when there is no login pair", () => {
    expect(findBrokeredMisuse([{ name: "X", brokerType: "auth-session" }], null)).toEqual(["X"]);
  });
  it("ignores runtime secrets", () => {
    expect(findBrokeredMisuse([{ name: "X", brokerType: null }], null)).toEqual([]);
  });
});

describe("defaultBrokerTypeForName", () => {
  it("defaults auth fields to auth-session", () => {
    for (const n of ["USERNAME", "login_password", "accountId", "user_email"])
      expect(defaultBrokerTypeForName(n)).toBe("auth-session");
  });
  it("returns null for non-auth names", () => {
    for (const n of ["openai_api_key", "region", "PROMPT"])
      expect(defaultBrokerTypeForName(n)).toBeNull();
  });

  // The reported bug: the console flipped ..._EMAIL to the auth broker but left
  // ..._PASSWORD on Runtime, and evaluateSessionRequirement rejects a split
  // pair outright — so the UI's own default produced an unrunnable workflow.
  // Both halves of a real login pair must classify the same way.
  it("classifies BOTH halves of a login pair identically", () => {
    for (const pair of [
      ["AGORA_CONSOLE_EMAIL", "AGORA_CONSOLE_PASSWORD"],
      ["VAPI_USERNAME", "VAPI_PASSWORD"],
      ["MY_ACCOUNT", "MY_PASSWORD"],
    ]) {
      const [email, password] = pair.map(defaultBrokerTypeForName);
      expect(password).toBe("auth-session");
      expect(email).toBe(password);
    }
  });
});

describe("isAuthFieldName (shared client/server heuristic)", () => {
  // The console and the API both pre-select the brokerType toggle from this
  // one predicate. A second copy is what drifted; these cases pin the union.
  it("matches every name either side used to match", () => {
    for (const n of ["USERNAME", "PASSWORD", "ACCOUNT", "EMAIL", "USER"])
      expect(isAuthFieldName(n)).toBe(true);
  });

  it("does NOT match a bare NAME", () => {
    // The console's old list carried bare NAME only to reach USERNAME, which is
    // matched directly. Keeping it would mark APP_NAME/CHANNEL_NAME as login
    // credentials, making Core withhold them from the agent and breaking runs
    // that work today — a false positive is more damaging than a false negative.
    for (const n of ["APP_NAME", "CHANNEL_NAME", "AGENT_NAME"])
      expect(isAuthFieldName(n)).toBe(false);
    expect(isAuthFieldName("USERNAME")).toBe(true);
  });
});

describe("resolveBrokerType", () => {
  it("defaults by name when unspecified", () =>
    expect(resolveBrokerType("PASSWORD", undefined)).toEqual({ ok: true, brokerType: "auth-session" }));
  it("honors explicit null override", () =>
    expect(resolveBrokerType("PASSWORD", null)).toEqual({ ok: true, brokerType: null }));
  it("rejects unknown type", () =>
    expect(resolveBrokerType("x", "openai-key")).toEqual({ ok: false, error: "unknown brokerType: openai-key" }));
  it("passes runtime name through as null", () =>
    expect(resolveBrokerType("region", undefined)).toEqual({ ok: true, brokerType: null }));
});
