/** Credential-free qualification of the packaged engine; run in the daemon image. */
import assert from "node:assert/strict";
import https from "node:https";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { BrowserControlConnection } from "../vox_eval_agentd/browser-control";
import { browserStatusSchema, supportsVerificationFlow, type BrowserCommand, type BrowserStatus } from "../shared/browser-assistance";

const elevenlabs = yaml.load(await fs.readFile("/app/aeval-data/config/platforms/elevenlabs.yaml", "utf8")) as {
  config: { authentication: { stages: { id: string; selector: string }[] } };
};
const emailStage = elevenlabs.config.authentication.stages.find((stage) => stage.id === "email");
assert.ok(emailStage, "The packaged ElevenLabs profile must define its email stage");

const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "vox-account-fixture-"));
const verificationTab = process.env.ACCOUNT_TEST_VERIFICATION_TAB;
const testManualTabs = process.env.ACCOUNT_TEST_MANUAL_TABS === "1";
let posts = 0;
let requireVerification = false;
let manualSignedIn = false;
let manualInput = "";
let evaluationAdvanced = false;
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
  "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem")], { stdio: "ignore" });
const server = https.createServer({ key: await fs.readFile(path.join(root, "key.pem")), cert: await fs.readFile(path.join(root, "cert.pem")) }, async (req, res) => {
  if (req.url === "/manual-input" && req.method === "POST") {
    for await (const chunk of req) manualInput += chunk;
    return res.end();
  }
  if (req.url === "/manual") {
    manualSignedIn = req.headers.cookie?.includes("fixture-session=accepted") ?? false;
    res.setHeader("Content-Type", "text/html");
    return res.end('<input autofocus oninput="fetch(\'/manual-input\',{method:\'POST\',body:this.value})">');
  }
  if (req.url === "/advanced") {
    evaluationAdvanced = true;
    return res.end("Evaluation advanced");
  }
  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const submitted = new URLSearchParams(body);
    const expectedEmail = submitted.get("email") === "fixture@example.invalid";
    if ((req.url === "/email" && !expectedEmail) || (req.url !== "/email" && submitted.get("password") !== "fixture-password")
      || (req.url === "/login" && !expectedEmail)) {
      res.writeHead(400); return res.end("Invalid fixture credentials");
    }
  }
  if (req.method === "POST" && req.url === "/login") {
    posts++;
    res.writeHead(303, requireVerification
      ? { Location: "/verify" }
      : { Location: "/home", "Set-Cookie": "fixture-session=accepted; Path=/; Secure; HttpOnly; SameSite=Lax" });
    return res.end();
  }
  if (req.method === "POST" && req.url === "/password") {
    posts++;
    res.writeHead(303, { Location: "/home", "Set-Cookie": "fixture-session=accepted; Path=/; Secure; HttpOnly; SameSite=Lax" });
    return res.end();
  }
  if (req.method === "POST" && req.url === "/email") {
    posts++;
    res.writeHead(303, { Location: "/password" });
    return res.end();
  }
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/verify") return res.end('<main>Open the verification link<input id="email" data-testid="sign-in-email-input" value="fixture@example.invalid" readonly><button id="submit" data-testid="sign-in-submit-button" disabled>Resend</button></main>');
  if (req.url === "/verify-link" && verificationTab) {
    return res.end('<form method="POST" action="/email"><input id="email" name="email" data-testid="sign-in-email-input"><button id="submit" data-testid="sign-in-submit-button">Sign in</button></form>');
  }
  if (req.url === "/verify-link" || req.url === "/password") return res.end('<form method="POST" action="/password"><input id="password" name="password" type="password"><button id="submit">Sign in</button></form>');
  if (req.url === "/home" || req.url === "/protected") {
    if (!req.headers.cookie?.includes("fixture-session=accepted")) {
      res.writeHead(303, { Location: "/login" }); return res.end();
    }
    return res.end('<main id="authenticated"><span id="ready">Authenticated fixture</span></main>');
  }
  res.end('<form method="POST" action="/login"><input id="email" data-testid="sign-in-email-input" name="email"><input id="password" name="password" type="password"><button id="submit" data-testid="sign-in-submit-button">Sign in</button></form>');
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `https://localhost:${(server.address() as { port: number }).port}`;
const storageFile = path.join(root, "account.json");
const platform = {
  name: "fixture", config: { url: `${origin}/protected`, ignore_https_errors: true, authentication: {
    login_origins: [origin], storage_origins: [origin], cookie_domains: ["localhost"],
    authenticated_url_patterns: ["**/home", "**/protected"], authenticated_selector: "#authenticated", authenticated_stability_ms: 50,
    ...(verificationTab ? { verification: { tab: verificationTab, origins: [origin] } } : {}),
    stages: [
      ...(verificationTab ? [{ id: "verify_email", selector: "button:text-is('Resend')" }] : []),
      { id: "email_password", selector: "body:has(#email) #password", fields: { email: "#email", password: "#password" }, submit: "#submit" },
      { id: "email", selector: emailStage.selector, fields: { email: "#email" }, submit: "#submit" },
      { id: "password", selector: "#password", fields: { password: "#password" }, submit: "#submit" },
    ],
  } },
  actions: {
    "setup:account": [{ type: "browser.ensure_authenticated", authentication: "${config.authentication}",
      restore_storage_file: "${params._restore_storage_file}", target_url: `${origin}/protected`,
      authenticated_selector: "#ready", email: "${params.email}", password: "${params.password}",
      storage_file: "${params.storage_file}", timeout_ms: 1500,
      post_login_timeout_ms: 1500, target_timeout_ms: 1500 }],
    "setup:storage": [
      { type: "browser.navigate", url: origin },
      { type: "browser.load_storage_state", file: "${params.storage_file}" },
      { type: "browser.navigate", url: `${origin}/protected` },
      { type: "browser.wait_for_element", selector: "#ready", timeout_ms: 1000 },
    ],
  },
};
await fs.mkdir(path.join(root, "config/platforms"), { recursive: true });
await fs.writeFile(path.join(root, "config/platforms/fixture.yaml"), yaml.dump(platform));

async function run(label: string, options: {
  storage?: string | null; mode?: string;
  assist?: (client: BrowserControlConnection, status: () => Promise<BrowserStatus>) => Promise<void>;
} = {}) {
  const sessionId = `vox-fixture-${randomUUID()}`;
  const scenario = path.join(root, `${sessionId}.yaml`);
  const socket = path.join(root, "control.sock");
  const params: Record<string, unknown> = { mode: options.mode ?? "account", email: "fixture@example.invalid", password: "fixture-password" };
  if (options.storage !== null) params.storage_file = options.storage ?? storageFile;
  await fs.writeFile(scenario, yaml.dump({ name: label, audio_io: { mode: "web_hook" }, steps: [
    { type: "platform.setup", platform_id: "fixture", mode: params.mode, params },
    ...(options.assist && verificationTab ? [{ type: "control.sleep", duration: 2000 }] : []),
    ...(testManualTabs ? [{ type: "control.sleep", duration: 5000 },
      { type: "browser.navigate", url: `${origin}/advanced` }, { type: "control.sleep", duration: 3000 }] : []),
  ] }), { mode: 0o600 });
  const engine = spawn(process.env.AEVAL_BINARY ?? "aeval", ["run", scenario, "--session-id", sessionId,
    "--output", path.join(root, "output"), ...(options.assist ? ["--browser-control-socket", socket, "--browser-assistance-timeout", "25"] : [])],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = "";
  engine.stdout.on("data", (chunk) => { output = (output + chunk).slice(-30000); });
  engine.stderr.on("data", (chunk) => { output = (output + chunk).slice(-30000); });
  const ended = new Promise<number | null>((resolve, reject) => { engine.once("error", reject); engine.once("close", resolve); });
  const client = new BrowserControlConnection(socket);
  const timer = setTimeout(() => { if (engine.pid) process.kill(-engine.pid, "SIGKILL"); }, 50000);
  try {
    if (options.assist) {
      const status = async () => {
        const response = await client.request({ version: 1, id: randomUUID(), command: "session.status" });
        assert.equal(response.ok, true); return browserStatusSchema.parse(response.result);
      };
      await until(async () => { try { await fs.stat(socket); return true; } catch { return false; } });
      await options.assist(client, status);
    }
    const exit = await ended;
    assert.equal(exit, 0, `${label}:\n${output}`);
    process.stdout.write(`PASS: ${label}\n`);
    return sessionId;
  } catch (error) { console.error(output); throw error; }
  finally {
    clearTimeout(timer); client.destroy();
    if (engine.pid && engine.exitCode === null && engine.signalCode === null) process.kill(-engine.pid, "SIGKILL");
    await ended.catch(() => undefined);
  }
}

async function until<T>(probe: () => Promise<T | false>): Promise<T> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await probe(); if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Account fixture timed out");
}

async function storageCases() {
  const initialSession = await run("account_missing_storage");
  assert.equal(posts, 1);
  const state = await fs.readFile(storageFile, "utf8");
  assert.equal((await fs.stat(storageFile)).mode & 0o777, 0o600);
  const readyRoot = path.join(`${storageFile}.checkpoints`, "ready", initialSession);
  const [readyName] = await fs.readdir(readyRoot);
  const ready = JSON.parse(await fs.readFile(path.join(readyRoot, readyName), "utf8"));
  assert.equal(ready.schema, "auth.checkpoint.v3");
  assert.equal(ready.session_id, initialSession);
  assert.equal(ready.protocol, undefined);
  assert.equal(await fs.readFile(path.join(`${storageFile}.checkpoints`, ready.snapshot), "utf8"), state);
  const initialPosts = posts;
  await run("account_accepted_storage_skips_credentials");
  assert.equal(posts, initialPosts, "Accepted storage must skip credential submission in a NEW engine execution");
  await run("storage_only_unchanged", { mode: "storage" });
  assert.equal(posts, initialPosts);
  await fs.writeFile(storageFile, "{broken", { mode: 0o600 });
  await run("account_corrupt_storage_falls_back_once");
  assert.equal(posts, initialPosts + 1);
  const rejected = JSON.parse(state);
  rejected.cookies[0].value = "rejected";
  await fs.writeFile(storageFile, JSON.stringify(rejected), { mode: 0o600 });
  await run("account_rejected_storage_falls_back_once");
  assert.equal(posts, initialPosts + 2);
  await run("account_without_storage_keeps_login_behavior", { storage: null });
  assert.equal(posts, initialPosts + 3);
}

try {
  if (testManualTabs) {
    await run("manual_tab_shares_login_without_holding_the_evaluation", { assist: async (client, status) => {
      let current = await until(async () => {
        const state = await status();
        return state.pages.length > 0 && posts === 1 && !state.assistance ? state : false;
      });
      const evaluationPage = current.pages[0];
      const call = async (command: BrowserCommand["command"], params: Record<string, unknown>) => client.request({
        version: 1, id: randomUUID(), command, session_id: current.session_id, browser_generation: current.browser_generation, params,
      });
      const opened = await call("viewer.open", { page_id: evaluationPage.page_id, document_epoch: evaluationPage.document_epoch });
      assert.equal(opened.ok, true);
      const leaseId = opened.result!.lease_id;
      const heartbeat = setInterval(() => { void call("viewer.heartbeat", { lease_id: leaseId }).catch(() => undefined); }, 1000);
      try {
        const openedTab = await call("viewer.open_tab", { lease_id: leaseId, page_id: evaluationPage.page_id,
          document_epoch: evaluationPage.document_epoch, sequence: current.next_sequence, url: `${origin}/manual` });
        assert.equal(openedTab.ok, true, JSON.stringify(openedTab));
        current = await status();
        const manualPage = current.pages.find((page) => page.page_id === openedTab.result!.page_id)!;
        assert.equal(manualPage.manual, true);
        assert.equal(manualSignedIn, true, "The manual tab inherits the evaluation tab's authenticated cookie");
        const selected = { lease_id: leaseId, page_id: manualPage.page_id, document_epoch: manualPage.document_epoch };
        const control = await call("viewer.take_control", selected);
        assert.equal(control.ok, true, JSON.stringify(control));
        const input = await call("viewer.input", { ...selected, control_id: control.result!.control_id,
          sequence: control.result!.next_sequence, input: { type: "text", text: "hello" } });
        assert.equal(input.ok, true, JSON.stringify(input));
        await until(async () => manualInput === "hello" && evaluationAdvanced);
        assert.equal((await status()).controlling, true, "The evaluation advances while manual input remains enabled");
        const closed = await call("viewer.close_tab", { ...selected, target_page_id: manualPage.page_id, target_document_epoch: manualPage.document_epoch });
        assert.equal(closed.ok, true, JSON.stringify(closed));
        current = await status();
        assert.equal(current.selected_page_id, evaluationPage.page_id);
        assert.deepEqual(current.pages.map((page) => page.page_id), [evaluationPage.page_id]);
      } finally { clearInterval(heartbeat); }
    } });
  } else {
  if (process.env.ACCOUNT_TEST_ASSISTANCE_ONLY !== "1") await storageCases();
  requireVerification = true;
  const assistedPosts = posts;
  await run(verificationTab ? `verification_flow_${verificationTab}` : "explicit_post_verification_credentials", { storage: path.join(root, "assisted.json"), assist: async (client, status) => {
    let current = await until(async () => { const next = await status(); return next.assistance ? next : false; });
    let selected = current.pages.find((page) => page.page_id === current.assistance!.page_id)!;
    const call = async (command: BrowserCommand["command"], params: Record<string, unknown>) => client.request({
      version: 1, id: randomUUID(), command, session_id: current.session_id, browser_generation: current.browser_generation, params,
    });
    const opened = await call("viewer.open", { page_id: selected.page_id, document_epoch: selected.document_epoch });
    assert.equal(opened.ok, true);
    const leaseId = opened.result!.lease_id;
    const identity = () => ({ lease_id: leaseId, page_id: selected.page_id, document_epoch: selected.document_epoch });
    const heartbeat = setInterval(() => { void call("viewer.heartbeat", { lease_id: leaseId }).catch(() => undefined); }, 1000);
    try {
      let control = await call("viewer.take_control", { ...identity(), wait_id: current.assistance!.wait_id });
      assert.equal(control.ok, true);
      if (verificationTab) {
        assert.equal(supportsVerificationFlow(current), true, JSON.stringify(current));
        const evaluationPageId = selected.page_id;
        const navigated = await call("authentication.open_verification", { ...identity(), wait_id: current.assistance!.wait_id,
          control_id: control.result!.control_id, sequence: control.result!.next_sequence, url: `${origin}/verify-link` });
        assert.equal(navigated.ok, true, JSON.stringify(navigated));
        assert.equal(navigated.result!.page_id === evaluationPageId, verificationTab === "original");
        current = await status();
        selected = current.pages.find((page) => page.page_id === navigated.result!.page_id)!;
        control = await call("viewer.take_control", { ...identity(), wait_id: current.assistance!.wait_id });
        assert.equal(control.ok, true, JSON.stringify(control));
        assert.equal(posts, assistedPosts + 1, "Opening the verification link does not submit credentials");
        const submitted = await call("authentication.continue_flow", { ...identity(), wait_id: current.assistance!.wait_id });
        assert.equal(submitted.ok, true, JSON.stringify(submitted));
        assert.equal(submitted.result!.checking, true);
        const ready = await until(async () => {
          const latest = await status();
          return latest.last_assistance?.state === "ready" ? latest : false;
        });
        assert.equal(ready.selected_page_id, evaluationPageId, "The viewer returns to the original evaluation tab");
        assert.equal(posts, assistedPosts + 3, "One consent submits the recognized email and password stages exactly once");
        return;
      }
      const navigated = await call("viewer.open_url", { ...identity(), control_id: control.result!.control_id,
        sequence: control.result!.next_sequence, url: `${origin}/verify-link`, new_page: true });
      assert.equal(navigated.ok, true);
      current = await status();
      selected = current.pages.find((page) => page.page_id === navigated.result!.page_id)!;
      control = await call("viewer.take_control", { ...identity(), wait_id: current.assistance!.wait_id });
      assert.equal(control.ok, true);
      const probe = await call("assistance.continue", { ...identity(), wait_id: current.assistance!.wait_id });
      assert.ok(probe.ok || probe.error === "AUTH_CREDENTIAL_CONTINUATION_REQUIRED");
      current = await until(async () => { const next = await status(); return next.assistance?.authentication?.stage_token ? next : false; });
      const stage = current.assistance!.authentication!;
      selected = current.pages.find((page) => page.page_id === navigated.result!.page_id)!;
      assert.equal(stage.page_id, selected.page_id, "Engine must track the verification tab's credential stage");
      assert.equal(posts, assistedPosts + 1, "Opening verification and passive status must not submit more credentials");
      if (!current.controlling) {
        control = await call("viewer.take_control", { ...identity(), wait_id: current.assistance!.wait_id });
        assert.equal(control.ok, true);
      }
      const readOnly = await call("assistance.continue", { ...identity(), wait_id: current.assistance!.wait_id });
      assert.equal(readOnly.ok, false);
      assert.equal(readOnly.error, "AUTH_CREDENTIAL_CONTINUATION_REQUIRED");
      assert.equal(posts, assistedPosts + 1);
      const stale = await call("authentication.continue", { ...identity(), wait_id: current.assistance!.wait_id,
        stage_id: stage.stage_id, stage_token: "stale-token" });
      assert.equal(stale.ok, false);
      assert.equal(posts, assistedPosts + 1);
      current = await status();
      const grant = current.assistance!.authentication!;
      const submitted = await call("authentication.continue", { ...identity(), wait_id: current.assistance!.wait_id,
        stage_id: grant.stage_id, stage_token: grant.stage_token });
      assert.equal(submitted.ok, true, submitted.error);
      await until(async () => posts === assistedPosts + 2);
    } finally { clearInterval(heartbeat); }
  } });
  assert.equal(posts, assistedPosts + (verificationTab ? 3 : 2), "Each recognized credential stage must submit exactly once");
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
}
