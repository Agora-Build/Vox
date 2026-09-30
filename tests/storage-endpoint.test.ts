import { describe, it, expect, afterEach } from "vitest";
import { isBlockedAddress, checkStorageEndpoint, guardedLookup } from "../server/storage-endpoint";

// Core connects to a user's own storage endpoint for Tools → Analyze. The user
// types that endpoint, so Core must never be steered into its own network:
// loopback, private ranges, link-local (cloud metadata), and the like — by the
// URL, or by what its name resolves to on each connection.

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
    // IPv4-mapped in hex (what the URL parser turns [::ffff:127.0.0.1] into),
    // IPv4-compatible, and NAT64 forms of internal addresses.
    "::ffff:7f00:1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "::7f00:1", "64:ff9b::a9fe:a9fe",
  ])("refuses %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["104.18.1.1", "52.216.1.2", "172.32.0.1", "100.128.0.1", "2606:4700::1", "::ffff:6812:101"])("allows %s", (ip) =>
    expect(isBlockedAddress(ip)).toBe(false));
});

describe("checkStorageEndpoint", () => {
  const saved = process.env.VOX_STORAGE_ALLOW_PRIVATE;
  afterEach(() => { process.env.VOX_STORAGE_ALLOW_PRIVATE = saved; });

  it("accepts a public HTTPS endpoint", () => {
    expect(() => checkStorageEndpoint("https://abc.r2.cloudflarestorage.com")).not.toThrow();
  });
  it("refuses plain HTTP, private literals, localhost and a bad URL", () => {
    for (const url of ["http://s3.example.com", "https://127.0.0.1:9000", "https://169.254.169.254", "https://[::1]", "https://localhost", "not a url",
      "https://[::ffff:127.0.0.1]", "https://[::ffff:a9fe:a9fe]", "https://[64:ff9b::a9fe:a9fe]"]) {
      expect(() => checkStorageEndpoint(url), url).toThrow();
    }
  });
  it("VOX_STORAGE_ALLOW_PRIVATE=1 (local development only) allows them", () => {
    process.env.VOX_STORAGE_ALLOW_PRIVATE = "1";
    expect(() => checkStorageEndpoint("http://127.0.0.1:9000")).not.toThrow();
  });
});

describe("guardedLookup", () => {
  const lookup = (host: string) => new Promise<string>((resolve, reject) =>
    guardedLookup(host, { all: true }, (err, addresses) => (err ? reject(err) : resolve(JSON.stringify(addresses)))));

  it("refuses a name that resolves into the private network, on the connection itself", async () => {
    await expect(lookup("localhost")).rejects.toThrow(/not allowed/);
  });
});
