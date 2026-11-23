import { describe, expect, it } from "vitest";
import {
  ACCOUNT_STATE_FORMAT, acceptsAccountStorage, parseAccountCheckpoint, parseAccountJson,
} from "../shared/account-session-protocol";

const id = "b".repeat(32);
const record = { schema: "auth.checkpoint.v3", session_id: "vox-40112-run-01", snapshot_id: id,
  sequence: 1, snapshot: `snapshots/vox-40112-run-01/${id}.json`, storage_format: ACCOUNT_STATE_FORMAT, byte_length: 1234 };
const filename = `0000000001-${id}.json`;
const scope = { cookieDomains: [".example.test"], storageOrigins: ["https://example.test"] };
const state = () => ({ cookies: [{ name: "session", value: "private-canary", domain: ".example.test", path: "/",
  expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
origins: [{ origin: "https://example.test", localStorage: [{ name: "token", value: "private-canary" }] }] });

describe("current account-checkpoint contract", () => {
  it("accepts only the expected session and exact ten-digit ready filename", () => {
    expect(parseAccountCheckpoint(JSON.stringify(record), record.session_id, filename)).toEqual(record);
    expect(parseAccountCheckpoint(JSON.stringify({ ...record, sequence: 9_999_999_999 }), record.session_id,
      `9999999999-${id}.json`).sequence).toBe(9_999_999_999);
  });

  it.each([
    { setup_id: "removed" }, { schema: "aeval.auth.v1" }, { session_id: "stale-execution" },
    { snapshot: "../../storage.json" }, { snapshot: `snapshots/other/${id}.json` },
    { snapshot_id: "B".repeat(32) }, { sequence: true }, { sequence: 0 }, { sequence: 10_000_000_000 },
    { sequence: 1.5 }, { storage_format: "browser-profile" }, { byte_length: 0 }, { byte_length: 2_097_153 },
  ])("rejects unexpected, stale or malformed metadata: %j", patch => {
    expect(() => parseAccountCheckpoint(JSON.stringify({ ...record, ...patch }), record.session_id, filename))
      .toThrow("Account checkpoint: invalid-record");
  });

  it("rejects a mismatched filename, unexpected session ID and duplicate metadata keys", () => {
    for (const [text, session, file] of [
      [JSON.stringify(record), record.session_id, `1-${id}.json`],
      [JSON.stringify(record), "../escape", filename],
      [JSON.stringify(record).replace('"sequence":1', '"sequence":2,"sequence":1'), record.session_id, filename],
    ]) expect(() => parseAccountCheckpoint(text, session, file)).toThrow("invalid-record");
  });

  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"outer":[{"x":1,"x":2}]}',
    '[[{"x":1,"x":2}]]', '{"private-canary":'])("rejects duplicate or invalid JSON without echoing input: %s", text => {
    try { parseAccountJson(text); throw new Error("unexpected acceptance"); }
    catch (error) { expect((error as Error).message).toBe("Account checkpoint: invalid-state"); }
  });

  it("handles escaped strings, whitespace, arrays and primitives without false duplicate matches", () => {
    const value = { a: ['text with " and \\ and {}', { b: true, c: null }, 12, -2.5, []], a2: { a: "safe" } };
    expect(parseAccountJson(JSON.stringify(value, null, 2))).toEqual(value);
    expect(parseAccountJson("null")).toBeNull();
    expect(() => parseAccountJson("[".repeat(66) + "0" + "]".repeat(66))).toThrow("invalid-state");
  });
});

describe("provider-scoped initial storage format", () => {
  it("accepts only approved secure cookie domains and canonical HTTPS storage origins", () => {
    expect(acceptsAccountStorage(state(), scope)).toBe(true);
    expect(acceptsAccountStorage({ cookies: [], origins: [] }, scope)).toBe(true);
  });

  it.each([
    { secure: false }, { domain: ".sub.example.test" }, { partitionKey: "unsupported" }, { expires: -2 },
    { sameSite: "unknown" }, { path: "relative" },
  ])("rejects unsafe or unsupported cookies: %j", patch => {
    const value = state(); Object.assign(value.cookies[0], patch);
    expect(acceptsAccountStorage(value, scope)).toBe(false);
  });

  it.each(["http://example.test", "https://example.test/", "https://example.test:443", "https://other.test"])("rejects a noncanonical or unapproved origin: %s", origin => {
    const value = state(); value.origins[0].origin = origin;
    expect(acceptsAccountStorage(value, scope)).toBe(false);
  });

  it("rejects duplicate cookies, storage origins/keys, unknown fields, and arbitrary Runtime maps", () => {
    const values = [state(), state(), state()];
    values[0].cookies.push(values[0].cookies[0]);
    values[1].origins.push(values[1].origins[0]);
    values[2].origins[0].localStorage.push(values[2].origins[0].localStorage[0]);
    for (const value of [...values, { ...state(), indexedDB: [] }, { PASSWORD: "private-canary" }]) {
      expect(acceptsAccountStorage(value, scope)).toBe(false);
    }
  });
});

