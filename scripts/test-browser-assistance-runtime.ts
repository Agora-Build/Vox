/** Credential-free packaged-engine check. Run inside the daemon image; see docs/browser-assistance.md. */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BrowserControlConnection, LocalBrowserSessions } from "../vox_eval_agentd/browser-control";
import { BrowserCaptures } from "../server/browser-capture";
import type { BrowserGrant } from "../server/browser-viewers";
import { browserStatusSchema, type BrowserCommand, type BrowserStatus } from "../shared/browser-assistance";

const work = await fs.mkdtemp(path.join(os.tmpdir(), "vox-runtime-test-"));
let loginPosts = 0;
let verificationPosts = 0;
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/login") {
    loginPosts++; res.writeHead(303, { Location: "/verify", "Set-Cookie": "fixture-login=1; Path=/; HttpOnly" }); return res.end();
  }
  if (req.method === "POST" && req.url === "/verify") {
    let body = ""; for await (const chunk of req) body += chunk;
    verificationPosts++;
    if (body !== "123456") { res.writeHead(400); return res.end(); }
    res.writeHead(200, { "Set-Cookie": "fixture-verified=1; Path=/; HttpOnly" }); return res.end("ok");
  }
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/protected") {
    if (!req.headers.cookie?.includes("fixture-verified=1")) { res.writeHead(302, { Location: "/login" }); return res.end(); }
    return res.end('<body style="background:#d7f5d8"><main id="ready">Verified fixture</main></body>');
  }
  if (req.url === "/verify") return res.end(`<body style="margin:0;background:#fff5df"><input id="code" style="position:absolute;left:40px;top:60px;width:300px;height:40px"><button id="verify" style="position:absolute;left:40px;top:130px;width:200px;height:40px" onclick="fetch('/verify',{method:'POST',body:document.querySelector('#code').value}).then(r=>{if(r.ok)document.body.dataset.verified='true'})">Verify</button></body>`);
  return res.end('<form method="POST" action="/login"><input id="email" name="email"><input id="password" name="password" type="password"><button id="submit">Sign in</button></form>');
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const socketPath = path.join(work, "control.sock");
const scenario = path.join(work, "scenario.yaml");
const saved = path.join(work, "state.json");
await fs.writeFile(scenario, `name: browser_assistance_fixture
audio_io:
  mode: web_hook
steps:
  - type: browser.ensure_authenticated
    target_url: ${origin}/protected
    authenticated_selector: '#ready'
    authenticated_stability_ms: 100
    login_url_pattern: '**/login'
    login_selector: '#email'
    email_selector: '#email'
    password_selector: '#password'
    submit_selector: '#submit'
    email: fixture@example.invalid
    password: fixture-password
    storage_file: ${saved}
    post_login_url_pattern: '**/home'
    timeout_ms: 30000
    target_timeout_ms: 30000
    post_login_timeout_ms: 30000
  - type: control.sleep
    duration: 100
`, { mode: 0o600 });
const engine = spawn(process.env.AEVAL_BINARY ?? "aeval", ["run", scenario, "--browser-control-socket", socketPath,
  "--browser-assistance-timeout", "20", "--output", path.join(work, "out")], {
  cwd: process.env.AEVAL_DATA_PATH ?? "/app/aeval-data", stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let output = "";
engine.stdout.on("data", (chunk) => { output = (output + chunk).slice(-20000); });
engine.stderr.on("data", (chunk) => { output = (output + chunk).slice(-20000); });
const ended = new Promise<number | null>((resolve, reject) => { engine.once("error", reject); engine.once("close", resolve); });
const inspector = new BrowserControlConnection(socketPath);
const local = new LocalBrowserSessions(socketPath);
const target = { key: "runtime-fixture", kind: "agent" as const, agentId: 1, leaseId: "fixture", generation: "fixture", jobId: 1, startedAt: new Date().toISOString() };
const owner: BrowserGrant = { id: randomUUID(), userId: 1, jobId: 1, target };
const observer: BrowserGrant = { ...owner, id: randomUUID(), userId: 2 };
let grants = [owner, observer]; let captureOpens = 0; let captureCloses = 0;
const captures = new BrowserCaptures(async () => grants, async (_target, operation) => {
  if (operation.request?.command === "viewer.open") captureOpens++;
  if (operation.action === "close") captureCloses++;
  return local.handle(operation);
});
const fixtureViewer = (grant: BrowserGrant) => ({
  request: (command: BrowserCommand) => captures.handle({ targetKey: target.key, viewerId: grant.id, action: "command", request: command }) as Promise<import("../shared/browser-assistance").BrowserResponse>,
  frame: () => captures.handle({ targetKey: target.key, viewerId: grant.id, action: "frame" }) as Promise<import("../shared/browser-assistance").BrowserFrame | null>,
});
const viewer = fixtureViewer(owner), spectator = fixtureViewer(observer);
const deadline = Date.now() + 90000;
async function until<T>(probe: () => Promise<T | null | false>): Promise<T> {
  while (Date.now() < deadline) {
    const result = await probe(); if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Packaged-engine fixture timed out");
}
const request = async (client: Pick<BrowserControlConnection, "request">, name: BrowserCommand["command"], status?: BrowserStatus, params?: Record<string, unknown>) => {
  const response = await client.request({ version: 1, id: randomUUID(), command: name,
    ...(status ? { session_id: status.session_id, browser_generation: status.browser_generation } : {}), ...(params ? { params } : {}) });
  assert.equal(response.ok, true, `Engine command ${name}: ${response.error}`); return response.result!;
};
let heartbeat: ReturnType<typeof setInterval> | undefined;
async function exercise() { try {
  await until(async () => { try { await fs.stat(socketPath); return true; } catch { return false; } });
  assert.equal((await fs.stat(work)).mode & 0o777, 0o700); assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
  const status = await until(async () => {
    const current = browserStatusSchema.parse(await request(inspector, "session.status"));
    return current.assistance && loginPosts === 1 ? current : false;
  });
  let selected = status.pages[0];
  const opened = await request(viewer, "viewer.open", status, { page_id: selected.page_id, document_epoch: selected.document_epoch });
  const joined = await request(spectator, "viewer.open", status, { page_id: selected.page_id, document_epoch: selected.document_epoch });
  assert.equal(joined.lease_id, opened.lease_id); assert.equal(captureOpens, 1, "Two viewers must share one real engine capture");
  assert.equal(opened.mode, "read_only"); const leaseId = opened.lease_id;
  const identity = () => ({ lease_id: leaseId, page_id: selected.page_id, document_epoch: selected.document_epoch });
  heartbeat = setInterval(() => { void request(viewer, "viewer.heartbeat", status, { lease_id: leaseId }).catch(() => undefined); }, 1000);
  const image = await until(async () => viewer.frame());
  assert.deepEqual(await spectator.frame(), image, "Spectators receive the same real frame, not a consumed queue entry");
  assert.ok(Buffer.from(image.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "A real JPEG frame must decode");
  const denied = await viewer.request({ version: 1, id: randomUUID(), command: "viewer.input", session_id: status.session_id,
    browser_generation: status.browser_generation, params: { ...identity(), sequence: 1, control_id: "not-granted", input: { type: "text", text: "denied" } } });
  assert.equal(denied.ok, false);
  let grant = await request(viewer, "viewer.take_control", status, { ...identity(), wait_id: status.assistance!.wait_id });
  const blocked = await spectator.request({ version: 1, id: randomUUID(), command: "viewer.take_control", session_id: status.session_id,
    browser_generation: status.browser_generation, params: { ...identity(), wait_id: status.assistance!.wait_id } });
  assert.equal(blocked.error, "CONTROL_BUSY");
  if (process.env.BROWSER_TEST_RELEASE === "1") {
    grants = [observer];
    await captures.handle({ targetKey: target.key, viewerId: owner.id, action: "leave" });
    const resumed = browserStatusSchema.parse(await request(inspector, "session.status"));
    assert.equal(resumed.controlling, false, "Controller disconnect must revoke engine input");
    assert.equal(resumed.viewing, true, "Spectators retain the engine capture");
    assert.ok(await spectator.frame());
    assert.equal(captureCloses, 0);
    grants = []; await captures.maintain(); assert.equal(captureCloses, 1);
    process.stdout.write("PASS: real Chromium: controller disconnect releases native input/hold, spectator keeps the same capture, final close stops capture\n");
    return;
  }
  const switched = await request(viewer, "viewer.select_page", status, { ...identity(), target_page_id: selected.page_id, target_document_epoch: selected.document_epoch });
  assert.equal(switched.page_id, selected.page_id);
  assert.equal(browserStatusSchema.parse(await request(inspector, "session.status")).controlling, false);
  grant = await request(viewer, "viewer.take_control", status, { ...identity(), wait_id: status.assistance!.wait_id });
  const navigated = await request(viewer, "viewer.open_url", status, { ...identity(), control_id: grant.control_id, sequence: grant.next_sequence, url: `${origin}/verify`, new_page: true });
  selected = { page_id: String(navigated.page_id), document_epoch: Number(navigated.document_epoch), origin };
  const refreshed = browserStatusSchema.parse(await request(inspector, "session.status"));
  selected = refreshed.pages.find((page) => page.page_id === selected.page_id)!;
  assert.ok(selected);
  grant = await request(viewer, "viewer.take_control", status, { ...identity(), wait_id: status.assistance!.wait_id });
  let sequence = Number(grant.next_sequence);
  const input = async (value: Record<string, unknown>) => {
    const result = await request(viewer, "viewer.input", status, { ...identity(), control_id: grant.control_id, sequence, input: value }); sequence = Number(result.next_sequence);
  };
  await input({ type: "mouse", action: "down", x: 80, y: 80, button: "left", click_count: 1 });
  await input({ type: "mouse", action: "up", x: 80, y: 80, button: "left", click_count: 1 });
  await input({ type: "text", text: "123456" });
  await input({ type: "mouse", action: "down", x: 80, y: 150, button: "left", click_count: 1 });
  await input({ type: "mouse", action: "up", x: 80, y: 150, button: "left", click_count: 1 });
  await until(async () => verificationPosts === 1);
  await request(viewer, "assistance.continue", status, { ...identity(), wait_id: status.assistance!.wait_id });
  assert.equal(await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error("Engine did not finish")), 30000).unref())]), 0, output);
  const storage = JSON.parse(await fs.readFile(saved, "utf8"));
  assert.ok(storage.cookies.some((cookie: { name: string }) => cookie.name === "fixture-verified"));
  assert.equal(loginPosts, 1, "Login must never be resubmitted"); assert.equal(verificationPosts, 1);
  grants = [observer]; await captures.handle({ targetKey: target.key, viewerId: owner.id, action: "leave" });
  assert.equal(captureCloses, 0, "Closing one viewer must not stop a spectator's capture");
  grants = []; await captures.maintain(); assert.equal(captureCloses, 1);
  process.stdout.write("PASS: packaged aeval + real Chromium: shared capture/frame fan-out, exclusive control, private socket, navigation fences, single submission, saved session and independent viewer cleanup\n");
} catch (error) {
  console.error(output); throw error;
} finally {
  if (heartbeat) clearInterval(heartbeat); inspector.destroy(); local.destroy();
  try { if (engine.pid && engine.exitCode === null && engine.signalCode === null) process.kill(-engine.pid, "SIGKILL"); } catch { /* already exited */ }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(work, { recursive: true, force: true });
} }
await exercise();
