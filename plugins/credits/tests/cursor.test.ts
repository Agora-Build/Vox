import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../server/cursor";

describe("cursor", () => {
  it("round-trips a positive id", () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
  });
  it("returns null for undefined/empty/garbage", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base64-!!")).toBeNull();
    expect(decodeCursor(encodeCursor(0))).toBeNull(); // 0 is not a valid keyset id
  });
});
