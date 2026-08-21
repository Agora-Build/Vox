import { describe, it, expect } from "vitest";
import { isKnownBrokerType, isInternalBrokerUrl, KNOWN_BROKER_TYPES } from "../server/broker-registry";

describe("isKnownBrokerType", () => {
  it("accepts auth-session", () => expect(isKnownBrokerType("auth-session")).toBe(true));
  it("rejects unknown", () => expect(isKnownBrokerType("openai-key")).toBe(false));
  it("rejects null/number", () => {
    expect(isKnownBrokerType(null)).toBe(false);
    expect(isKnownBrokerType(1)).toBe(false);
  });
  it("KNOWN_BROKER_TYPES is exactly [auth-session]", () =>
    expect([...KNOWN_BROKER_TYPES]).toEqual(["auth-session"]));
});

describe("isInternalBrokerUrl", () => {
  it("accepts loopback http", () => expect(isInternalBrokerUrl("http://127.0.0.1:8200")).toBe(true));
  it("accepts RFC1918", () => {
    expect(isInternalBrokerUrl("http://10.1.2.3:8200")).toBe(true);
    expect(isInternalBrokerUrl("http://192.168.0.5:8200")).toBe(true);
    expect(isInternalBrokerUrl("http://172.16.4.4:8200")).toBe(true);
  });
  it("accepts single-label DNS and .internal/.local", () => {
    expect(isInternalBrokerUrl("http://vox-auth-session-broker:8200")).toBe(true);
    expect(isInternalBrokerUrl("http://broker.internal:8200")).toBe(true);
    expect(isInternalBrokerUrl("http://broker.local:8200")).toBe(true);
  });
  it("rejects public host", () => expect(isInternalBrokerUrl("http://broker.example.com:8200")).toBe(false));
  it("rejects https and non-http schemes", () => {
    expect(isInternalBrokerUrl("https://10.1.2.3:8200")).toBe(false);
    expect(isInternalBrokerUrl("ftp://10.1.2.3")).toBe(false);
  });
  it("rejects public RFC1918-lookalike (172.32)", () => expect(isInternalBrokerUrl("http://172.32.0.1")).toBe(false));
  it("rejects garbage", () => expect(isInternalBrokerUrl("not a url")).toBe(false));
});
