import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserAssistanceTimeoutSeconds } from "../shared/browser-assistance-timeout";
import { DEFAULT_MINT_TIMEOUT_SECONDS, MAX_MINT_TIMEOUT_SECONDS, SESSION_MINT_POLL_TIMEOUT_SECONDS, mintTimeoutSeconds } from "../shared/mint-timeout";
import { mintWithAeval } from "../vox_eval_agentd/auth-session-broker";
import { mintViaBroker } from "../server/broker-registry";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function configure(login = "", assistance = "") {
  vi.stubEnv("WEB_SESSION_MINT_TIMEOUT_SECONDS", login);
  vi.stubEnv("VOX_BROWSER_ASSISTANCE_TIMEOUT_SECONDS", assistance);
}

describe("coordinated login and browser assistance budgets", () => {
  it("defaults to ten minutes for login and two minutes for assistance", () => {
    configure();
    expect(DEFAULT_MINT_TIMEOUT_SECONDS).toBe(600);
    expect(mintTimeoutSeconds()).toBe(600);
    expect(browserAssistanceTimeoutSeconds()).toBe(120);
    expect(SESSION_MINT_POLL_TIMEOUT_SECONDS).toBe(640);
    expect(SESSION_MINT_POLL_TIMEOUT_SECONDS).toBeGreaterThan(MAX_MINT_TIMEOUT_SECONDS + 30);
  });

  it.each(["1", "90", "180", "600", " 240\r\n"])("supports a configured assistance timeout %j", (value) => {
    configure("600", value);
    expect(browserAssistanceTimeoutSeconds()).toBe(Number(value));
  });

  it.each(["0", "-1", "1.5", "120abc", "NaN", "Infinity", "1e3", "9007199254740992"])("rejects malformed assistance timeout %j", (value) => {
    configure("600", value);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(browserAssistanceTimeoutSeconds()).toBe(120);
  });

  it.each([
    ["90", "", 90], ["90", "180", 90], ["600", "900", 600],
    ["900", "900", 600], ["1", "120", 1], ["90", "invalid", 90],
  ])("caps assistance with login budget %j and assistance setting %j", (login, assistance, expected) => {
    configure(login, assistance);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(browserAssistanceTimeoutSeconds()).toBe(expected);
  });

  it("also respects the actual broker child's shorter budget", () => {
    configure("600", "300");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(browserAssistanceTimeoutSeconds(45)).toBe(45);
    expect(browserAssistanceTimeoutSeconds(180.9)).toBe(180);
    configure("90", "300");
    expect(browserAssistanceTimeoutSeconds(600)).toBe(90);
  });

  it("sends Core's configured login budget to the broker and keeps its abort outside it", async () => {
    configure("420");
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ platformId: "test", timeoutSeconds: 420 });
      expect(init?.signal).toBeDefined();
      return new Response(JSON.stringify({ storageState: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await mintViaBroker({ id: 1, url: "http://broker.test", mintSecret: "test" },
      { platformId: "test", email: "test@example.test", password: "test-password" }, fetchImpl as typeof fetch);
    expect(timeout).toHaveBeenCalledWith(435_000);
  });

  it.each([
    [600_000, undefined, "", 120],
    [600_000, undefined, "240", 240],
    [600_000, 45, "240", 45],
    [30_000, undefined, "240", 30],
  ])("passes the bounded timeout to the real broker child (%j, %j, %j)", async (timeoutMs, requested, assistance, expected) => {
    configure("600", assistance);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const directory = mkdtempSync(join(tmpdir(), "vox-timeout-test-"));
    const capture = join(directory, "args.json");
    const executable = join(directory, "aeval");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
const scenario = fs.readFileSync(process.argv[3], 'utf8');
const storage = JSON.parse(scenario.match(/^      storage_file: (.+)$/m)[1]);
fs.writeFileSync(storage, JSON.stringify({cookies: [], origins: []}));
`);
    chmodSync(executable, 0o700);
    vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
    try {
      await mintWithAeval({ platformId: "test", email: "test@example.test", password: "test-password",
        browserOperationId: "test-operation", timeoutSeconds: requested }, timeoutMs);
      const args: string[] = JSON.parse(readFileSync(capture, "utf8"));
      expect(args[args.indexOf("--browser-assistance-timeout") + 1]).toBe(String(expected));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
