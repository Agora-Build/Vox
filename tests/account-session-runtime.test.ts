import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { prepareAccountRuntime } from "../vox_eval_agentd/account-session-runtime";
import { createAccountWorkspace, sweepAccountWorkspaces } from "../vox_eval_agentd/account-workspace";
import { ACCOUNT_STATE_FORMAT } from "../shared/account-session-protocol";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const saved = JSON.stringify({ cookies: [], origins: [{ origin: "https://elevenlabs.io", localStorage: [{ name: "session", value: "session-file-canary" }] }] });
async function fixture(patch: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vox-runtime-account-test-")); roots.push(root);
  const scenarioFile = path.join(root, "scenario.yaml"), sessionId = `vox-40112-${randomUUID()}`;
  const setup = { type: "platform.setup", platform_id: "elevenlabs", params: { mode: "account", email: "fixture@example.invalid",
    password: "fixture-password", storage_file: ".auth/shared.json", ...patch } };
  fs.writeFileSync(scenarioFile, yaml.dump({ name: "fixture", steps: [setup, { type: "control.log", message: "benchmark" }] }));
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ status: "ready", state: saved, grant: "private-grant" })));
  const input = { scenarioFile, sessionId, jobId: 40112, leaseId: "lease", startedAt: new Date().toISOString(),
    credentialRevision: "a".repeat(64) as string | null, fetch, cancelled: () => false };
  return { input, setup, root, fetch };
}
function readSetup(file: string) { return (yaml.load(fs.readFileSync(file, "utf8")) as { steps: Array<{ params: Record<string, string> }> }).steps[0].params; }
function publish(storageFile: string, sessionId: string) {
  const sidecar = `${storageFile}.checkpoints`, id = randomBytes(16).toString("hex");
  const snapshot = `snapshots/${sessionId}/${id}.json`;
  fs.mkdirSync(path.join(sidecar, "snapshots", sessionId), { mode: 0o700, recursive: true });
  fs.mkdirSync(path.join(sidecar, "ready", sessionId), { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(sidecar, '.writer.lock'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(sidecar, snapshot), saved, { mode: 0o600 });
  const record = { schema: "auth.checkpoint.v3", session_id: sessionId, snapshot_id: id, sequence: 1, snapshot,
    storage_format: ACCOUNT_STATE_FORMAT, byte_length: Buffer.byteLength(saved) };
  fs.writeFileSync(path.join(sidecar, 'ready', sessionId, `0000000001-${id}.json`), JSON.stringify(record), { mode: 0o600 });
  return record;
}

describe.skipIf(process.platform !== 'linux')("Runtime account-session execution lifecycle", () => {
  it("restores into an isolated private path, keeps account mode and never reads the configured shared path", async () => {
    const { input, fetch } = await fixture();
    const run = (await prepareAccountRuntime(input))!;
    const params = readSetup(run.scenarioFile);
    expect(params.mode).toBe('account'); expect(params.email).toBe('fixture@example.invalid'); expect(params.password).toBe('fixture-password');
    expect(path.isAbsolute(params.storage_file)).toBe(true); expect(params.storage_file).not.toContain('.auth/shared.json');
    expect(fs.readFileSync(params.storage_file, 'utf8')).toBe(saved);
    expect(fs.statSync(params.storage_file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(params.storage_file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ sessionId: input.sessionId,
      leaseId: input.leaseId, startedAt: input.startedAt, credentialRevision: input.credentialRevision });
    await run.finish(); expect(fs.existsSync(run.scenarioFile)).toBe(false);
  });
  it.each([{ mode: 'storage' }, { storage_file: '' }, { storage_file: null }])("leaves storage-only and omitted-file behavior unchanged: %j", async patch => {
    const { input, fetch } = await fixture(patch);
    expect(await prepareAccountRuntime(input)).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it("separates cache failure from evaluation and cleans plaintext on finalization after engine failure", async () => {
    const { input, fetch } = await fixture(); fetch.mockRejectedValue(new Error('Core unavailable'));
    const run = (await prepareAccountRuntime(input))!;
    expect(fs.existsSync(readSetup(run.scenarioFile).storage_file)).toBe(false);
    await run.finish(); expect(fs.existsSync(run.scenarioFile)).toBe(false);
  });
  it("uses a private file without cache access when credentials had no matching revision marker", async () => {
    const { input, fetch } = await fixture(); input.credentialRevision = null;
    const run = (await prepareAccountRuntime(input))!;
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(readSetup(run.scenarioFile).storage_file)).toBe(false);
    await run.finish(); expect(fs.existsSync(run.scenarioFile)).toBe(false);
  });
  it("uploads the exact immutable checkpoint, never the mutable working file, on final flush", async () => {
    const { input, fetch } = await fixture();
    const run = (await prepareAccountRuntime(input))!, params = readSetup(run.scenarioFile);
    const record = publish(params.storage_file, input.sessionId);
    fs.writeFileSync(params.storage_file, 'working file was replaced after authentication');
    fetch.mockImplementation(async (url, init) => {
      if (url.endsWith('/release')) return new Response('{}');
      const body = JSON.parse(String(init.body));
      expect(body.state).toBe(saved); expect(body.record).toEqual(record); expect(body.grant).toBe('private-grant');
      return new Response(JSON.stringify({ status: 'persisted', sessionId: input.sessionId, snapshotId: record.snapshot_id }));
    });
    await run.finish();
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/checkpoints'))).toBe(true);
    expect(fs.existsSync(params.storage_file)).toBe(false);
  });
  it("retries an unknown upload response with identical identity and handles explicit revocation without failing cleanup", async () => {
    const { input, fetch } = await fixture(), run = (await prepareAccountRuntime(input))!;
    const params = readSetup(run.scenarioFile), record = publish(params.storage_file, input.sessionId);
    const bodies: string[] = [];
    fetch.mockImplementation(async (url, init) => {
      if (url.endsWith('/release')) return new Response('{}');
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new Error('commit response lost');
      return new Response(JSON.stringify({ status: 'persisted', sessionId: input.sessionId, snapshotId: record.snapshot_id }));
    });
    await run.finish(); expect(bodies.length).toBe(2); expect(bodies[0]).toBe(bodies[1]);
    expect(fs.existsSync(params.storage_file)).toBe(false);
  });
  it("does not upload cancelled work and still destroys its private plaintext root", async () => {
    const { input, fetch } = await fixture(), run = (await prepareAccountRuntime(input))!;
    const params = readSetup(run.scenarioFile); publish(params.storage_file, input.sessionId);
    input.cancelled = () => true;
    await run.finish();
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/checkpoints'))).toBe(false);
    expect(fs.existsSync(params.storage_file)).toBe(false);
  });
  it("startup/crash sweeps skip a live workspace held by its lifetime lock", () => {
    const workspace = createAccountWorkspace();
    try {
      fs.writeFileSync(workspace.storageFile, saved, { mode: 0o600 });
      const old = new Date(Date.now() - 120_000); fs.utimesSync(workspace.root, old, old);
      sweepAccountWorkspaces(); expect(fs.existsSync(workspace.storageFile)).toBe(true);
    } finally { workspace.close(); }
  });
});
