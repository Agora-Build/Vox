import { describe, expect, it } from "vitest";
import { extractVerificationUrl } from "../server/browser-verification-url";

const target = "https://elevenlabs.io/app/action?mode=verifyEmail&oobCode=fixture%2Bcode%3D&lang=en#finish";
const origin = "https://elevenlabs.io";
const outlook = (url: string) => `https://apc01.safelinks.protection.outlook.com/?url=${encodeURIComponent(url)}&data=fixture`;
const checkpoint = (url: string) => `https://protect.checkpoint.com/v2/r01/___${url}___.fixture_signature`;
const otherWrapper = (url: string) => `https://mail-security.example/redirect?destination=${encodeURIComponent(url)}&ticket=fixture`;

describe("verification link extraction", () => {
  it.each([
    target, outlook(target), checkpoint(target), outlook(checkpoint(target)), checkpoint(encodeURIComponent(target)),
  ])("keeps the destination and its encoded query intact", (link) => {
    expect(extractVerificationUrl(link)).toBe(target);
  });

  it("keeps a delimiter inside the target query", () => {
    const link = "https://elevenlabs.io/app/action?code=value___.part";
    expect(extractVerificationUrl(checkpoint(link))).toBe(link);
  });

  it("does not interpret wrapper-like fields on unrecognized hosts", () => {
    const spoof = `https://safelinks.protection.outlook.com.example.test/?url=${encodeURIComponent(target)}`;
    expect(extractVerificationUrl(spoof)).toBe(spoof);
  });

  it.each([
    otherWrapper(target), otherWrapper(encodeURIComponent(target)), otherWrapper(otherWrapper(target)),
    outlook(otherWrapper(target)), otherWrapper(checkpoint(target)),
  ])("infers a unique destination on the active origin without knowing the wrapper host", (link) => {
    expect(extractVerificationUrl(link, origin)).toBe(target);
  });

  it("preserves a direct provider link with an embedded return URL", () => {
    const direct = `${target.split("#")[0]}&return=${encodeURIComponent(`${origin}/app/home`)}`;
    expect(extractVerificationUrl(direct, origin)).toBe(direct);
  });

  it.each([
    otherWrapper("https://elevenlabs.io.example.test/verify"),
    otherWrapper("https://elevenlabs.io:8443/verify"),
    otherWrapper("https://different-provider.example/verify"),
    `${otherWrapper(target)}&other=${encodeURIComponent(`${origin}/different-action`)}`,
  ])("rejects off-origin or ambiguous inferred targets", (link) => {
    expect(extractVerificationUrl(link, origin)).toBeNull();
  });

  it.each([
    "http://elevenlabs.io/app/action",
    "https:///elevenlabs.io/app/action",
    "https://user@elevenlabs.io/app/action",
    "https://elevenlabs.io/verify\ncode",
    "https://elevenlabs.io\\verify",
    "https://apc01.safelinks.protection.outlook.com/?data=missing",
    `${outlook(target)}&url=${encodeURIComponent(target)}`,
    "https://protect.checkpoint.com/v2/r01/___https://elevenlabs.io/app/action",
    checkpoint("https%3A%2F%2Felevenlabs.io%2Fverify%ZZ"),
    outlook(checkpoint("http://elevenlabs.io/app/action")),
    outlook(outlook(outlook(outlook(outlook(target))))),
  ])("rejects malformed or unsafe links", (link) => {
    expect(extractVerificationUrl(link)).toBeNull();
  });
});
