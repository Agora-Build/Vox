import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { credentialForms, htmlForms, redactValues } from "../shared/credentials";
import { mintViaBroker } from "../server/broker-registry";
import { mintWithAeval } from "../vox_eval_agentd/auth-session-broker";

// #139: follow-ups from the #133 review of the auth-session broker's error path.

describe("#139 HTML-entity spellings of a credential", () => {
  it("covers the escapes a page writes an account in", () => {
    const forms = htmlForms("ann.lee@agora.io");
    expect(forms).toContain("ann.lee&#64;agora.io");                    // only the @ (email obfuscation)
    expect(forms).toContain("ann.lee&#x40;agora.io");
    expect(forms).toContain("ann&#46;lee&#64;agora&#46;io");            // every non-alphanumeric
    expect(htmlForms(`p&"<'x`)).toContain("p&amp;&quot;&lt;&#39;x");   // ordinary escaping
    expect(htmlForms("abc123")).toEqual([]);                            // nothing to encode, nothing added
    expect(() => htmlForms("pw\ud800end")).not.toThrow();               // lone surrogate
  });

  it("a page dump quoting the email as &#64; is redacted", () => {
    const page = `<input value="ann.lee&#64;agora.io"> Login failed for ann.lee&#x40;agora.io`;
    const out = redactValues(page, credentialForms(["ann.lee@agora.io", "hunter2-pass"]));
    expect(out).not.toMatch(/ann\.lee/);
    expect(out).toBe(`<input value="[redacted]"> Login failed for [redacted]`);
  });
});

describe("#139 Core's backstop URL-reduces the broker's error", () => {
  const target = { id: 1, url: "http://broker.test", mintSecret: "s" };
  const brokerSays = (error: string) => (async () =>
    new Response(JSON.stringify({ error }), { status: 502, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("a broker that failed to reduce doesn't get a full URL into the stored error", async () => {
    const err = await mintViaBroker(target, { platformId: "p", email: "ann@agora.io", password: "hunter2-pass" },
      brokerSays("stuck on https://sso.example.com/en/login?login_hint=ann.lee&session=abc123")).catch((e) => e as Error);
    expect(err.message).toContain("https://sso.example.com/…");
    expect(err.message).not.toMatch(/login_hint|abc123|ann\.lee/);
  });

  it("a URL-valued credential is redacted whole, not cut apart by the reduction", async () => {
    const err = await mintViaBroker(target, { platformId: "p", email: "ann@agora.io", password: "wss://proj.example.cloud/rtc" },
      brokerSays("connect failed: wss://proj.example.cloud/rtc?access_token=JWT")).catch((e) => e as Error);
    expect(err.message).not.toMatch(/proj\.example|JWT/);
    expect(err.message).toContain("[redacted]");
  });
});

describe("#139 the mint-timeout clamp is said out loud", () => {
  const saved = process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS;
  afterEach(() => {
    if (saved === undefined) delete process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS;
    else process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS = saved;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("warns once when the configured value is over the ceiling, and uses the ceiling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mintTimeoutSeconds, MAX_MINT_TIMEOUT_SECONDS } = await import("../shared/mint-timeout");
    process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS = "600";
    expect(mintTimeoutSeconds()).toBe(MAX_MINT_TIMEOUT_SECONDS);
    expect(mintTimeoutSeconds()).toBe(MAX_MINT_TIMEOUT_SECONDS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/600.*ceiling.*using 200s/);
  });

  it("stays quiet for a value within range", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mintTimeoutSeconds } = await import("../shared/mint-timeout");
    process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS = "120";
    expect(mintTimeoutSeconds()).toBe(120);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("#139 a malformed minted storage file", () => {
  const savedPath = process.env.PATH;
  afterEach(() => { process.env.PATH = savedPath; });

  it("fails with a stated cause, never the file's content", async () => {
    // A stand-in aeval that 'logs in' and leaves a broken session file.
    const bin = mkdtempSync(join(tmpdir(), "fake-aeval-"));
    const aeval = join(bin, "aeval");
    writeFileSync(aeval, `#!/bin/sh
f=$(sed -n 's/^ *storage_file: "\\(.*\\)"$/\\1/p' "$2")
printf '{"cookies":[{"name":"sid","value":"SECRET-COOKIE"' > "$f"
exit 0
`);
    chmodSync(aeval, 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    const err = await mintWithAeval({ platformId: "p", email: "ann@agora.io", password: "hunter2-pass" }, 20_000).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("login completed but the saved storage state is not valid JSON");
    expect(err.message).not.toContain("SECRET-COOKIE");
  });
});
