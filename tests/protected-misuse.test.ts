import { describe, it, expect } from "vitest";
import { findProtectedMisuse } from "../server/session-broker";

describe("findProtectedMisuse", () => {
  const pair = { emailSecret: "LOGIN_EMAIL", passwordSecret: "LOGIN_PW" };
  it("allows protected secrets that are exactly the login pair", () => {
    const classified = [
      { name: "LOGIN_EMAIL", class: "protected" },
      { name: "LOGIN_PW", class: "protected" },
    ];
    expect(findProtectedMisuse(classified, pair)).toEqual([]);
  });
  it("flags a protected secret referenced outside the login pair", () => {
    const classified = [
      { name: "LOGIN_EMAIL", class: "protected" },
      { name: "LOGIN_PW", class: "protected" },
      { name: "API_TOKEN", class: "protected" },
    ];
    expect(findProtectedMisuse(classified, pair)).toEqual(["API_TOKEN"]);
  });
  it("flags any protected ref when there is no login pair", () => {
    expect(findProtectedMisuse([{ name: "X", class: "protected" }], null)).toEqual(["X"]);
  });
  it("ignores runtime secrets", () => {
    expect(findProtectedMisuse([{ name: "X", class: "runtime" }], null)).toEqual([]);
  });
});
