/** Released aeval + Chromium + disposable Core/PostgreSQL qualification fixture.
 * Run only in an isolated container with elevenlabs.io mapped to 127.0.0.1;
 * the HTTPS provider below is synthetic, never a real ElevenLabs account.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import https from "node:https";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import express from "express";
import yaml from "js-yaml";
import { prepareIsolatedCoreDb } from "../tests/helpers/isolated-core-db";
import { prepareAccountRuntime } from "../vox_eval_agentd/account-session-runtime";
import { createBrokerServer, mintWithAeval } from "../vox_eval_agentd/auth-session-broker";

assert.equal(process.env.ACCOUNT_SESSION_FIXTURE_ISOLATED, "1", "Requires an isolated disposable container");
assert.equal((await lookup("elevenlabs.io")).address, "127.0.0.1", "Never contact the real provider");
assert.match(execFileSync("aeval", ["--version"], { encoding: "utf8" }), /\b0\.5\.3\b/);
assert.ok(process.env.DATABASE_URL, "Requires a disposable PostgreSQL instance");
process.env.DATABASE_URL = await prepareIsolatedCoreDb(process.env.DATABASE_URL, `vox_test_real_account_${process.pid}`);
process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);
process.env.WEB_SESSION_MINT_TIMEOUT_SECONDS = "20";
process.env.VOX_BROWSER_ASSISTANCE_TIMEOUT_SECONDS = "3";
const { pool, storage, hashToken, encryptValue, decryptValue } = await import("../server/storage");
const { registerAccountSessionRoutes } = await import("../server/routes-account-sessions");
const { runtimeAccountCredentialDelivery } = await import("../server/account-session-service");
const { ensureSession, credentialKeyFor } = await import("../server/auth-session");
const { publishBrokerMintSecret } = await import("../server/broker-registry");
const { coreRouting } = await import("../server/core-routing-runtime");
const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "vox-account-core-fixture-"));
const cookieCanary = "vox-private-auth-cookie-canary";
let submissions = 0, blocked = false;
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=elevenlabs.io",
  "-addext", "subjectAltName=DNS:elevenlabs.io", "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem")], { stdio: "ignore" });
const provider = https.createServer({ key: await fs.readFile(path.join(root, "key.pem")), cert: await fs.readFile(path.join(root, "cert.pem")) }, async (req, res) => {
  if (req.method === "POST" && req.url === "/login") {
    let body = ""; for await (const chunk of req) body += chunk;
    const fields = new URLSearchParams(body);
    assert.equal(fields.get("email"), "fixture@example.invalid"); assert.equal(fields.get("password"), "fixture-password"); submissions++;
    res.writeHead(303, { Location: "/home", "Set-Cookie": `session=${cookieCanary}; Path=/; Secure; HttpOnly; SameSite=Lax` }); return res.end();
  }
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/home" || req.url === "/protected") {
    if (!req.headers.cookie?.includes(`session=${cookieCanary}`)) { res.writeHead(303, { Location: "/login" }); return res.end(); }
    return res.end(req.url === "/protected" && blocked ? '<main>Preview unavailable</main>' : '<main id="authenticated"><span id="ready">Authenticated</span></main>');
  }
  res.end('<form method="POST" action="/login"><input id="email" name="email"><input id="password" name="password" type="password"><button id="submit">Sign in</button></form>');
});
await new Promise<void>(resolve => provider.listen(443, '0.0.0.0', resolve));
const origin = "https://elevenlabs.io";
const platform = { name: "elevenlabs", config: { url: `${origin}/protected`, ignore_https_errors: true, authentication: {
  login_origins: [origin], storage_origins: [origin], cookie_domains: ["elevenlabs.io"],
  authenticated_url_patterns: ["**/home", "**/protected"], authenticated_selector: "#authenticated", authenticated_stability_ms: 50,
  stages: [{ id: "email_password", selector: "#email", fields: { email: "#email", password: "#password" }, submit: "#submit" }],
} }, actions: { "setup:account": [{ type: "browser.ensure_authenticated", authentication: "${config.authentication}",
  restore_storage_file: "${params._restore_storage_file}", target_url: `${origin}/protected`, authenticated_selector: "#ready",
  email: "${params.email}", password: "${params.password}", storage_file: "${params.storage_file}",
  timeout_ms: 1500, post_login_timeout_ms: 1500, target_timeout_ms: 1500 }] } };
await fs.mkdir(path.join(root, "config/platforms"), { recursive: true });
await fs.writeFile(path.join(root, "config/platforms/elevenlabs.yaml"), yaml.dump(platform));
const app = express(); app.use(express.json({ limit: "13mb" })); registerAccountSessionRoutes(app);
const core = createServer(app); await new Promise<void>(resolve => core.listen(0, "127.0.0.1", resolve));
const coreUrl = `http://127.0.0.1:${(core.address() as { port: number }).port}`;
let broker: ReturnType<typeof createBrokerServer> | null = null;
const config = { scenario: 'steps: []', stepsPrefix: '- type: platform.setup\n  platform_id: elevenlabs\n  params:\n    mode: account\n    email: ${secrets.EMAIL}\n    password: ${secrets.PASSWORD}\n    storage_file: .auth/elevenlabs.json\n' };
const need = { platformId: "elevenlabs", emailSecret: "EMAIL", passwordSecret: "PASSWORD" };
try {
  await pool.query("INSERT INTO users(id,username,email,is_enabled) VALUES(1,'fixture','fixture@vox.invalid',true)");
  await storage.createOrUpdateSecret(1, "EMAIL", encryptValue("fixture@example.invalid"));
  await storage.createOrUpdateSecret(1, "PASSWORD", encryptValue("fixture-password"));
  const token = await storage.createEvalAgentToken({ name: "fixture", createdBy: 1, dispatchTier: "private", tokenHash: hashToken("fixture-agent-token") });
  const agent = await storage.createEvalAgent({ name: "fixture", tokenId: token.id, currentLeaseId: "fixture-lease", state: "occupied" });
  await pool.query("UPDATE eval_agents SET last_seen_at=clock_timestamp() WHERE id=$1", [agent.id]);
  for (const shouldFail of [true, false]) {
    const job = await pool.query(`INSERT INTO eval_jobs(config,snapshot,status,created_by,eval_agent_id,started_at)
      VALUES($1,$2,'running',1,$3,date_trunc('milliseconds',now())) RETURNING id,started_at AT TIME ZONE 'UTC' AS started_at`,
    [config, { evalFlow: { name: "fixture", config, ownerId: 1, organizationId: null } }, agent.id]);
    const jobId = job.rows[0].id, sessionId = `vox-${jobId}-${randomUUID()}`;
    const scenarioFile = path.join(root, `${sessionId}.yaml`);
    await fs.writeFile(scenarioFile, yaml.dump({ name: 'account_fixture', audio_io: { mode: 'web_hook' }, steps: [
      { type: 'platform.setup', platform_id: 'elevenlabs', params: { mode: 'account', email: 'fixture@example.invalid', password: 'fixture-password', storage_file: '.auth/elevenlabs.json' } },
      ...(shouldFail ? [{ type: 'browser.wait_for_element', selector: '#never-present', timeout_ms: 100 }] : []),
    ] }), { mode: 0o600 });
    const delivery = await runtimeAccountCredentialDelivery({ jobId, tokenHash: hashToken("fixture-agent-token"),
      startedAt: job.rows[0].started_at.toISOString(), leaseId: 'fixture-lease' });
    assert.ok(delivery);
    const run = await prepareAccountRuntime({ scenarioFile, sessionId, jobId, startedAt: job.rows[0].started_at.toISOString(), leaseId: 'fixture-lease',
      credentialRevision: delivery.credentialRevision, cancelled: () => false,
      fetch: (url, options) => fetch(`${coreUrl}${url}`, { ...options, redirect: 'error', headers: { authorization: 'Bearer fixture-agent-token', 'content-type': 'application/json' } }) });
    assert.ok(run);
    const params = (yaml.load(await fs.readFile(run.scenarioFile, 'utf8')) as { steps: Array<{ params: { mode: string; storage_file: string } }> }).steps[0].params;
    assert.equal(params.mode, 'account');
    const child = spawn('aeval', ['run', run.scenarioFile, '--session-id', sessionId, '--output', path.join(root, 'output')], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output = (output + chunk).slice(-20_000); }); child.stderr.on('data', chunk => { output = (output + chunk).slice(-20_000); });
    const timer = setTimeout(() => { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }, 45_000);
    let exit: number | null;
    try { exit = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }); }
    finally { clearTimeout(timer); await run.finish(); }
    assert.equal(exit === 0, !shouldFail, output);
    await assert.rejects(fs.stat(run.scenarioFile), { code: 'ENOENT' });
    assert.equal(submissions, 1, 'Second Runtime execution must restore rather than resubmit credentials');
    await pool.query("UPDATE eval_jobs SET status=$2 WHERE id=$1", [jobId, shouldFail ? 'failed' : 'completed']);
    process.stdout.write(`PASS: Runtime ${shouldFail ? 'confirmed auth survives later evaluation failure' : 'next job restores from encrypted Core state without login'}\n`);
  }
  await storage.createOrUpdateSecret(1, 'EMAIL', encryptValue('fixture@example.invalid'), { brokerType: 'auth-session' });
  await storage.createOrUpdateSecret(1, 'PASSWORD', encryptValue('fixture-password'), { brokerType: 'auth-session' });
  broker = createBrokerServer({ getSecret: () => 'fixture-broker-secret', mint: r => mintWithAeval(r, 20_000, { coreUrl, dataPath: root }) });
  await new Promise<void>(resolve => broker!.listen(0, '127.0.0.1', resolve));
  const registration = await storage.createBrokerRegistrationToken({ name: 'fixture', createdBy: 1, tokenHash: 'fixture-broker-token', isRevoked: false, expiresAt: null });
  const registered = await storage.createBroker({ name: 'fixture', tokenId: registration.id, brokerType: 'auth-session',
    url: `http://127.0.0.1:${(broker.address() as { port: number }).port}`, currentLeaseId: 'fixture-broker-lease', state: 'idle', lastSeenAt: new Date() });
  await coreRouting.start(); await publishBrokerMintSecret(registered.id, 'fixture-broker-lease', 'fixture-broker-secret');
  blocked = true;
  await ensureSession({ userId: 1 }, need);
  let session = await storage.getWebSession({ userId: 1 }, 'elevenlabs', credentialKeyFor(need));
  assert.equal(session?.status, 'ready', 'Confirmed broker authentication must survive a later preview failure');
  assert.equal(session.encryptedStorageState, null, 'Only account_sessions is canonical');
  assert.equal(submissions, 2);
  process.stdout.write('PASS: Broker checkpoint committed independently of later preview failure\n');
  blocked = false;
  await pool.query("UPDATE web_sessions SET expires_at=now()-interval '1 second'");
  await ensureSession({ userId: 1 }, need);
  session = await storage.getWebSession({ userId: 1 }, 'elevenlabs', credentialKeyFor(need));
  assert.equal(session?.status, 'ready'); assert.equal(submissions, 2, 'Broker refresh must restore prior state first');
  process.stdout.write('PASS: Broker refresh restores through a mint-scoped Core endpoint without login\n');
  const legacy = await mintWithAeval({ platformId: 'elevenlabs', email: 'fixture@example.invalid', password: 'fixture-password' },
    20_000, { dataPath: root });
  assert.ok(JSON.stringify(legacy).includes(cookieCanary), 'New broker must still answer legacy Core mint requests');
  process.stdout.write('PASS: Updated broker remains compatible with legacy Core mint requests\n');
  const states = (await pool.query('SELECT source,encrypted_storage_state FROM account_sessions ORDER BY source')).rows;
  assert.deepEqual(states.map(r => r.source), ['brokered', 'runtime']);
  for (const row of states) { assert.ok(!row.encrypted_storage_state.includes(cookieCanary)); assert.ok(decryptValue(row.encrypted_storage_state).includes(cookieCanary)); }
  const walk = async (dir: string): Promise<string[]> => {
    const files: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name); if (entry.isDirectory()) files.push(...await walk(file)); else files.push(file);
    }
    return files;
  };
  for (const file of await walk(path.join(root, 'output'))) {
    const text = await fs.readFile(file, 'utf8'); assert.ok(!text.includes(cookieCanary), `Session state leaked into ${path.basename(file)}`);
    assert.ok(!text.includes('fixture-password'), `Password leaked into ${path.basename(file)}`);
  }
  process.stdout.write('PASS: Source isolation, encrypted-at-rest state, private-root cleanup and artifact canaries\n');
} finally {
  await coreRouting.stop(); broker?.closeAllConnections(); broker?.close(); core.closeAllConnections(); core.close(); provider.closeAllConnections(); provider.close();
  await pool.end(); await fs.rm(root, { recursive: true, force: true });
}
