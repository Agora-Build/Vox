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
    // Valid secret names are UPPER_SNAKE (SECRET_NAME_PATTERN), which is what
    // the token-boundary match is built for. "accountId" was in this list
    // before but is not a name the API would ever accept.
    for (const n of ["USERNAME", "LOGIN_PASSWORD", "ACCOUNT_ID", "USER_EMAIL"])
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
  // NOT a general property of the pattern — a pair can still split (e.g. a
  // password named without any of the four tokens). These are the shapes
  // actually used, including the pair from the bug report.
  it("classifies both halves of the common login-pair shapes identically", () => {
    for (const pair of [
      ["AGORA_CONSOLE_EMAIL", "AGORA_CONSOLE_PASSWORD"],
      ["VAPI_USERNAME", "VAPI_PASSWORD"],
      ["MY_ACCOUNT", "MY_PASSWORD"],
      ["LOGIN_USER", "LOGIN_PASSWORD"],
      ["USER_NAME", "USER_PASSWORD"],
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
  it("matches the login fields both sides agreed on", () => {
    for (const n of ["USERNAME", "PASSWORD", "ACCOUNT", "EMAIL"])
      expect(isAuthFieldName(n)).toBe(true);
    // USER needs a login-ish prefix and must end the name: LOGIN_USER is an
    // identifier paired with a password, DB_USER and USER_AGENT are not.
    expect(isAuthFieldName("USER")).toBe(true);
    expect(isAuthFieldName("LOGIN_USER")).toBe(true);
    expect(isAuthFieldName("DB_USER")).toBe(false);
    expect(isAuthFieldName("USER_AGENT")).toBe(false);
  });

  it("still matches a digit-suffixed credential name", () => {
    // A false negative defaults a credential to the RUNTIME class, which is the
    // agent-exposed one — so this direction leaks, while a false positive only
    // breaks availability. PASSWORD2/EMAIL2 are ordinary second-test-account
    // names, and MYPASSWORD ends in a credential word.
    for (const n of [
      "PASSWORD2", "EMAIL2", "ACCOUNT1", "MYPASSWORD", "AGORAEMAIL", "USERNAME2",
      "SUPPORT_EMAILS", "LOGIN_PASSWORDS",         // plurals
    ]) {
      expect(isAuthFieldName(n)).toBe(true);
    }
  });

  it("matches on token boundaries, not substrings", () => {
    // Both old copies were wrong in opposite directions because they matched
    // substrings. A false positive is the damaging direction: Core withholds
    // the secret from the agent and a working run breaks.
    for (const n of [
      "APP_NAME", "CHANNEL_NAME", "AGENT_NAME",   // console's bare NAME
      "USER_AGENT", "USER_ID", "CURRENT_USER_ID", // bare USER
      "END_USER_TOKEN", "SUPERUSER_KEY",
      "EMAILER_API_KEY",                          // EMAIL followed by a letter
      "EMAILADDRESS", "ACCOUNTNAME",              // trailing word: deliberate residual
      // Infra credentials. A false positive here is not "withheld from the
      // agent" — findBrokeredMisuse rejects the WHOLE workflow, so accepting
      // the console's pre-selection on DB_USER would make it unrunnable.
      "DB_USER", "SMTP_USER", "POSTGRES_USER", "REDIS_USER",
      // Plural followed by more name, rather than ending the name.
      "MAX_USERS", "ACTIVE_USERS", "ACCOUNTS_URL", "EMAILS_SENT_COUNT",
    ]) {
      expect(isAuthFieldName(n)).toBe(false);
    }
    // ...while the names those tokens were reaching for still match directly.
    for (const n of [
      "USERNAME", "VAPI_USERNAME", "MY_ACCOUNT", "LOGIN_EMAIL",
      // The USER family, anchored at the end so it pairs with a password
      // without dragging in USER_AGENT above.
      "USER_NAME", "LOGIN_USER", "CONSOLE_USER", "USER",
    ]) {
      expect(isAuthFieldName(n)).toBe(true);
    }
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
