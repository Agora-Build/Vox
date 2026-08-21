import { describe, it, expect } from "vitest";
import { findBrokeredMisuse, defaultBrokerTypeForName } from "../server/auth-session";

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
});
