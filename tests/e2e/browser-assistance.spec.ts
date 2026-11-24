import { test, expect, type Page } from "@playwright/test";
import type { BrowserStatus, BrowserViewerState } from "../../shared/browser-assistance";

async function viewerFixture(page: Page, options: { authorized?: boolean; delayGrant?: Promise<void>; cancellationDelivery?: "pending" | "acknowledged" } = {}) {
  await page.request.post("/api/auth/login", { data: { email: "admin@vox.local", password: "admin123456" } });
  const base = "/api/eval-jobs/987654/browser";
  const viewerId = "8d57271e-9fae-4c4c-b82a-03604cf402bf";
  const commands: Record<string, unknown>[] = [];
  let closed = 0; let unknown = false;
  const status: BrowserStatus = { session_id: "session", browser_generation: "generation", capabilities: ["viewer.read_only", "viewer.control"],
    pages: [{ page_id: "login", document_epoch: 1, origin: "https://login.example" }, { page_id: "verification", document_epoch: 1, origin: "https://verify.example" }],
    viewing: true, controlling: false, next_sequence: 1, assistance: { wait_id: "wait", kind: "authentication", state: "waiting", page_id: "login", remaining_seconds: null } };
  const sharing: BrowserViewerState = { count: 2, controller: null, revision: 0, lease_id: "lease", page_id: "login", document_epoch: 1 };
  await page.route("**/api/eval-jobs/987654/detail", (route) => route.fulfill({ json: {
    job: { id: 987654, kind: "eval", transport: "web", status: "running", createdAt: new Date().toISOString(), config: {}, tags: [] },
    result: null, evalFlowName: "Browser fixture", creatorName: "Fixture", canAccessBrowser: options.authorized ?? true, canCancel: false,
    canCancelRunning: !!options.cancellationDelivery,
  } }));
  await page.route(`**${base}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/cancel-job")) return route.fulfill({ json: { cancelled: true, cancellationDelivery: options.cancellationDelivery } });
    if (route.request().method() === "DELETE") { closed++; return route.fulfill({ json: { closed: true } }); }
    if (url.pathname === `${base}/viewers`) { if (options.delayGrant) await options.delayGrant; return route.fulfill({ json: { viewerId } }); }
    if (url.pathname.endsWith("/commands")) {
      const command = route.request().postDataJSON(); commands.push(command);
      sharing.revision++; sharing.document_epoch = status.pages.find((item) => item.page_id === sharing.page_id)!.document_epoch;
      if (!status.controlling) sharing.controller = null;
      const response = { version: 1, type: "response", id: command.id, ok: true, result: {} as Record<string, unknown>, viewer: sharing };
      if (command.command === "session.status") response.result = status as unknown as Record<string, unknown>;
      if (command.command === "viewer.open") response.result = { lease_id: "lease", mode: "read_only" };
      if (command.command === "viewer.take_control") {
        status.controlling = true; sharing.controller = "you";
        if (status.assistance && command.params.wait_id) status.assistance.state = "held";
        response.result = { control_id: "control", next_sequence: status.next_sequence };
      }
      if (command.command === "viewer.release_control") { status.controlling = false; sharing.controller = null; }
      if (command.command === "assistance.continue") {
        status.controlling = false; sharing.controller = null;
        status.assistance!.state = "checking"; status.assistance!.reason = "checking";
        response.result = { checking: true };
      }
      if (command.command === "authentication.continue") {
        status.controlling = false; sharing.controller = null;
        status.assistance!.state = "checking"; status.assistance!.authentication = null;
        response.result = { checking: true };
      }
      if (command.command === "authentication.open_verification") {
        status.controlling = false; sharing.controller = null;
        sharing.document_epoch = ++status.pages[0].document_epoch;
        response.result = { page_id: "login", document_epoch: sharing.document_epoch, next_sequence: 2 };
      }
      if (command.command === "authentication.continue_flow") {
        status.controlling = false; sharing.controller = null;
        status.assistance!.state = "checking";
        response.result = { checking: true };
      }
      if (command.command === "viewer.input") {
        if (unknown) return route.fulfill({ json: { ...response, ok: false, error: "OUTCOME_UNKNOWN" } });
        response.result = { next_sequence: Number(command.params.sequence) + 1 };
      }
      if (command.command === "viewer.open_tab") {
        status.controlling = false; sharing.controller = null;
        sharing.page_id = "manual"; sharing.document_epoch = 1;
        status.pages.push({ page_id: "manual", document_epoch: 1, origin: "https://login.example", manual: true });
        response.result = { page_id: "manual", document_epoch: 1, next_sequence: ++status.next_sequence };
      }
      if (command.command === "viewer.close_tab") {
        status.controlling = false; sharing.controller = null;
        status.pages = status.pages.filter((item) => item.page_id !== "manual");
        sharing.page_id = "login"; sharing.document_epoch = status.pages[0].document_epoch;
        response.result = { closed: true, page_id: "login", document_epoch: sharing.document_epoch };
      }
      if (command.command === "viewer.select_page") {
        const target = status.pages.find((item) => item.page_id === command.params.target_page_id)!;
        status.controlling = false; sharing.controller = null;
        sharing.page_id = target.page_id; sharing.document_epoch = target.document_epoch;
        response.result = { page_id: target.page_id, document_epoch: target.document_epoch };
      }
      return route.fulfill({ json: response });
    }
    if (url.pathname.endsWith("/frame")) return route.fulfill({ json: { version: 1, type: "event", event: "viewer.frame", session_id: "session", browser_generation: "generation",
      page_id: "login", document_epoch: status.pages[0].document_epoch, lease_id: "lease", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", metadata: { deviceWidth: 800, deviceHeight: 600 } } });
    return route.fulfill({ json: { available: true, target: "broker", status } });
  });
  await page.goto("/console/eval-jobs/987654");
  return { commands, status, sharing, closed: () => closed, unknown: () => { unknown = true; } };
}

test("viewer opens read-only, explicitly acquires control, sends text in order, and closes capture", async ({ page }) => {
  const fixture = await viewerFixture(page);
  await page.getByTestId("button-open-browser").click();
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(page.getByTestId("browser-frame")).toBeVisible();
  await expect(page.getByTestId("browser-viewer-count")).toHaveText("2 viewers");
  await expect(page.getByLabel("Browser tab")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Check & continue" })).toBeDisabled();
  expect(fixture.commands.some((command) => command.command === "viewer.take_control")).toBe(false);
  await page.getByTestId("button-take-browser-control").click();
  await expect(page.getByText("You have control")).toBeVisible();
  await page.getByLabel("Text to send to browser").fill("123456"); await page.getByRole("button", { name: "Send text", exact: true }).click();
  await expect.poll(() => fixture.commands.filter((command) => command.command === "viewer.input").length).toBe(1);
  expect(fixture.commands.find((command) => command.command === "viewer.input")?.params).toMatchObject({ sequence: 1, input: { type: "text", text: "123456" } });
  await page.getByRole("button", { name: "Close view", exact: true }).click();
  await expect.poll(fixture.closed).toBe(1);
});

test("spectators see exclusive ownership and can explicitly take control only after release", async ({ page }) => {
  const fixture = await viewerFixture(page);
  fixture.status.controlling = true; fixture.sharing.controller = "other";
  await page.getByTestId("button-open-browser").click();
  await expect(page.getByTestId("button-take-browser-control")).toHaveText("Another viewer has control");
  await expect(page.getByTestId("button-take-browser-control")).toBeDisabled();
  await expect(page.getByLabel("Browser tab")).toBeDisabled();
  fixture.status.controlling = false; fixture.sharing.controller = null;
  await expect(page.getByTestId("button-take-browser-control")).toBeEnabled();
  await page.getByTestId("button-take-browser-control").click();
  await expect(page.getByText("You have control")).toBeVisible();
  await page.getByTestId("button-release-browser-control").click();
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(page.getByTestId("browser-frame")).toBeVisible();
  expect(fixture.commands.filter((command) => command.command === "viewer.release_control")).toHaveLength(1);
  expect(fixture.closed()).toBe(0);
});

test("continuation shows live readiness, the original evaluation tab, and the confirmed outcome", async ({ page }) => {
  const fixture = await viewerFixture(page);
  await page.getByTestId("button-open-browser").click();
  await page.getByTestId("button-take-browser-control").click();
  await page.getByLabel("Browser tab").click();
  await page.getByRole("option", { name: /Tab 2/ }).click();
  await expect(page.getByTestId("browser-evaluation-tab")).toHaveText("Evaluation checks Tab 1; you are viewing another tab");
  await page.getByTestId("button-take-browser-control").click();
  await page.getByRole("button", { name: "Check & continue" }).click();
  const feedback = page.getByTestId("browser-readiness-status");
  await expect(feedback).toContainText("Checking the evaluation tab");
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  fixture.status.assistance!.reason = "selector_absent";
  fixture.status.assistance!.last_check_reason = "selector_absent";
  await expect(feedback).toContainText("required page element is not visible yet");
  await expect(feedback).toContainText("retrying until the assistance deadline");
  fixture.status.last_assistance = { ...fixture.status.assistance!, state: "ready", reason: "ready", last_check_reason: "ready" };
  fixture.status.assistance = null;
  await expect(feedback).toContainText("Readiness confirmed");
  await expect(feedback).not.toContainText("Checking");
  await expect(page.getByTestId("button-take-browser-control")).toBeDisabled();
  expect(fixture.commands.filter((command) => command.command === "assistance.continue")).toHaveLength(1);
});

test("an expired check replaces Checking with its safe failure reason and never resubmits", async ({ page }) => {
  const fixture = await viewerFixture(page);
  await page.getByTestId("button-open-browser").click();
  await page.getByTestId("button-take-browser-control").click();
  await page.getByRole("button", { name: "Check & continue" }).click();
  fixture.status.last_assistance = { ...fixture.status.assistance!, state: "expired", reason: "assistance_expired", last_check_reason: "still_on_login", remaining_seconds: 0 };
  fixture.status.assistance = null;
  const feedback = page.getByTestId("browser-readiness-status");
  await expect(feedback).toContainText("Browser assistance expired");
  await expect(feedback).toContainText("still on the login page");
  await expect(feedback).not.toContainText("resumed");
  await expect(feedback).not.toContainText("Checking");
  await expect(page.getByTestId("button-take-browser-control")).toBeDisabled();
  expect(fixture.commands.filter((command) => command.command === "assistance.continue")).toHaveLength(1);
});

test("a recognized post-verification stage needs explicit credential consent and uses engine stage fences", async ({ page }) => {
  const fixture = await viewerFixture(page);
  fixture.status.assistance!.authentication = { stage_id: "password", page_id: "verification", stage_token: "opaque-stage" };
  await page.getByTestId("button-open-browser").click();
  const signIn = page.getByRole("button", { name: "Sign in & continue", exact: true });
  await expect(signIn).toBeDisabled();
  await expect(page.getByTestId("browser-readiness-status")).toContainText("authorizes aeval");
  expect(fixture.commands.filter((command) => command.command === "authentication.continue")).toHaveLength(0);
  await page.getByTestId("button-take-browser-control").click();
  await expect(signIn).toBeEnabled();
  await signIn.click();
  await expect(signIn).not.toBeVisible();
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  const submitted = fixture.commands.filter((command) => command.command === "authentication.continue");
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({ session_id: "session", browser_generation: "generation", params: {
    lease_id: "lease", page_id: "login", document_epoch: 1, wait_id: "wait", stage_id: "password", stage_token: "opaque-stage",
  } });
  expect(fixture.commands.filter((command) => command.command === "assistance.continue")).toHaveLength(0);
  await page.waitForTimeout(1300);
  expect(fixture.commands.filter((command) => command.command === "authentication.continue")).toHaveLength(1);
});

test("a readiness-only check needing credentials retains control for explicit consent", async ({ page }) => {
  const fixture = await viewerFixture(page);
  await page.route("**/api/eval-jobs/987654/browser/viewers/*/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.command !== "assistance.continue") return route.fallback();
    fixture.status.assistance!.authentication = { stage_id: "password", page_id: "verification", stage_token: "opaque" };
    return route.fulfill({ json: { version: 1, type: "response", id: command.id, ok: false, error: "AUTH_CREDENTIAL_CONTINUATION_REQUIRED" } });
  });
  await page.getByTestId("button-open-browser").click();
  await page.getByTestId("button-take-browser-control").click();
  await page.getByRole("button", { name: "Check & continue" }).click();
  await expect(page.getByText("You have control")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in & continue", exact: true })).toBeEnabled();
  expect(fixture.commands.filter((command) => command.command === "authentication.continue")).toHaveLength(0);
});

test("provider verification uses the evaluation tab and one consent click waits for readiness", async ({ page }) => {
  const fixture = await viewerFixture(page);
  fixture.status.capabilities.push("auth.verification-flow.v1");
  fixture.status.assistance!.authentication = { stage_id: null, page_id: null, stage_token: null, verification_flow: true };
  await page.getByTestId("button-open-browser").click();
  const signIn = page.getByRole("button", { name: "Sign in & continue", exact: true });
  await expect(signIn).toBeDisabled();
  await expect(page.getByRole("button", { name: "Check & continue" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New tab" })).toHaveCount(0);
  await page.getByTestId("button-take-browser-control").click();
  const destination = "https://login.example/verify?mode=verifyEmail&oobCode=fixture%2Bcode";
  const checkpoint = `https://protect.checkpoint.com/v2/r01/___${destination}___.fixture_signature`;
  const emailLink = `https://apc01.safelinks.protection.outlook.com/?url=${encodeURIComponent(checkpoint)}&data=fixture`;
  await page.getByLabel("Verification URL").fill(emailLink);
  await page.getByRole("button", { name: "Open verification link" }).click();
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  expect(fixture.commands.find((command) => command.command === "authentication.open_verification")?.params)
    .toEqual({ lease_id: "lease", page_id: "login", document_epoch: 1, wait_id: "wait", control_id: "control", sequence: 1, url: emailLink });
  await expect(page.getByLabel("Browser tab")).toHaveText(/Tab 1 \(evaluation\)/);
  await page.getByTestId("button-take-browser-control").click();
  await expect(page.getByTestId("browser-readiness-status")).toContainText("use this flow's account credentials");
  await signIn.click();
  await expect(page.getByTestId("browser-readiness-status")).toContainText("Finishing sign-in");
  expect(fixture.commands.filter((command) => command.command === "authentication.continue_flow")).toHaveLength(1);
  fixture.status.last_assistance = { ...fixture.status.assistance!, state: "ready", reason: "ready" };
  fixture.status.assistance = null;
  await expect(page.getByTestId("browser-readiness-status")).toContainText("Readiness confirmed");
  expect(fixture.commands.filter((command) => command.command === "authentication.continue_flow")).toHaveLength(1);
  expect(fixture.commands.some((command) => command.command === "authentication.continue" || command.command === "assistance.continue")).toBe(false);
});

test("a rejected email wrapper keeps control and allows pasting the direct link", async ({ page }) => {
  const fixture = await viewerFixture(page);
  fixture.status.capabilities.push("auth.verification-flow.v1");
  fixture.status.assistance!.authentication = { stage_id: null, page_id: null, stage_token: null, verification_flow: true };
  let rejected: string | undefined;
  await page.route("**/api/eval-jobs/987654/browser/viewers/*/commands", (route) => {
    const command = route.request().postDataJSON();
    if (command.command !== "authentication.open_verification" || rejected) return route.fallback();
    rejected = command.params.url;
    return route.fulfill({ json: { version: 1, type: "response", id: command.id, ok: false, error: "INVALID_VERIFICATION_LINK" } });
  });
  await page.getByTestId("button-open-browser").click();
  await page.getByTestId("button-take-browser-control").click();
  const wrapped = "https://mail-security.example/link?ticket=opaque";
  await page.getByLabel("Verification URL").fill(wrapped);
  await page.getByRole("button", { name: "Open verification link" }).click();
  await expect(page.getByText(/Try the provider's direct link/)).toBeVisible();
  await expect(page.getByText("You have control")).toBeVisible();
  await expect(page.getByLabel("Verification URL")).toHaveValue("");
  expect(rejected).toBe(wrapped);

  const direct = "https://login.example/verify?code=fixture";
  await page.getByLabel("Verification URL").fill(direct);
  await page.getByRole("button", { name: "Open verification link" }).click();
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(page.getByText(/Try the provider's direct link/)).toHaveCount(0);
  expect(fixture.commands.find((command) => command.command === "authentication.open_verification")?.params).toMatchObject({ url: direct });
});

test("manual tabs take input outside a wait and close individually", async ({ page }) => {
  const fixture = await viewerFixture(page);
  fixture.status.capabilities.push("viewer.manual-tabs.v1");
  fixture.status.assistance = null;
  await page.getByTestId("button-open-browser").click();
  await expect(page.getByTestId("button-take-browser-control")).toBeDisabled();
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByLabel("New tab URL").fill("https://login.example/other-page");
  await page.getByRole("button", { name: "Open tab", exact: true }).click();
  await expect(page.getByLabel("Browser tab")).toHaveText(/\(manual\)/);
  await page.getByTestId("button-take-browser-control").click();
  expect(fixture.commands.find((command) => command.command === "viewer.take_control")?.params).toEqual({ lease_id: "lease", page_id: "manual", document_epoch: 1 });
  await page.getByLabel("Text to send to browser").fill("in the manual tab");
  await page.getByRole("button", { name: "Send text" }).click();
  await expect.poll(() => fixture.commands.filter((command) => command.command === "viewer.input").length).toBe(1);
  await page.getByRole("button", { name: "Close tab", exact: true }).click();
  await expect(page.getByLabel("Browser tab")).toHaveText(/Tab 1 \(evaluation\)/);
  await expect(page.getByRole("button", { name: "Close tab", exact: true })).toHaveCount(0);
  expect(fixture.closed()).toBe(0);
});

test("sign in from a manual tab goes back to the evaluation before submitting consent", async ({ page }) => {
  const fixture = await viewerFixture(page);
  fixture.status.capabilities.push("auth.verification-flow.v1", "viewer.manual-tabs.v1");
  fixture.status.assistance!.authentication = { stage_id: null, page_id: null, stage_token: null, verification_flow: true };
  await page.getByTestId("button-open-browser").click();
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByLabel("New tab URL").fill("https://login.example/other-page");
  await page.getByRole("button", { name: "Open tab", exact: true }).click();
  await expect(page.getByLabel("Browser tab")).toHaveText(/\(manual\)/);
  await page.getByRole("button", { name: "Sign in & continue", exact: true }).click();
  await expect(page.getByTestId("browser-readiness-status")).toContainText("Finishing sign-in");
  expect(fixture.commands.find((command) => command.command === "authentication.continue_flow")?.params)
    .toMatchObject({ page_id: "login", wait_id: "wait" });
  expect(fixture.status.pages.some((tab) => tab.manual)).toBe(true);
});

test("an unconfirmed credential action closes control and offers an explicit reopen without replay", async ({ page }) => {
  const fixture = await viewerFixture(page);
  fixture.status.assistance!.authentication = { stage_id: "password", page_id: "verification", stage_token: "opaque" };
  let attempts = 0;
  await page.route("**/api/eval-jobs/987654/browser/viewers/*/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.command !== "authentication.continue") return route.fallback();
    attempts++;
    return route.fulfill({ json: { version: 1, type: "response", id: command.id, ok: false, error: "OUTCOME_UNKNOWN" } });
  });
  await page.getByTestId("button-open-browser").click();
  await page.getByTestId("button-take-browser-control").click();
  await page.getByRole("button", { name: "Sign in & continue", exact: true }).click();
  await expect(page.getByText(/Reopen the browser and inspect its state/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
  await expect.poll(fixture.closed).toBe(1);
  await page.waitForTimeout(1200);
  expect(attempts).toBe(1);
});

test("slow navigation and status do not block the viewer heartbeat", async ({ page }) => {
  const fixture = await viewerFixture(page);
  let resume!: () => void, navigating = false;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  await page.route("**/api/eval-jobs/987654/browser/viewers/*/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.command === "viewer.open_url") {
      navigating = true; await paused;
      return route.fulfill({ json: { version: 1, type: "response", id: command.id, ok: true,
        result: { page_id: "login", document_epoch: 1 } } });
    }
    if (navigating && command.command === "session.status") await paused;
    await route.fallback();
  });
  try {
    await page.getByTestId("button-open-browser").click();
    await page.getByTestId("button-take-browser-control").click();
    await page.getByLabel("Verification URL").fill("https://verify.example/code");
    await page.getByRole("button", { name: "Open in new tab" }).click();
    await expect.poll(() => navigating).toBe(true);
    await expect.poll(() => fixture.commands.filter((command) => command.command === "viewer.heartbeat").length,
      { timeout: 5000 }).toBeGreaterThanOrEqual(3);
  } finally { resume(); }
});

test("navigation drops control, and an unknown input outcome is never automatically replayed", async ({ page }) => {
  const fixture = await viewerFixture(page); await page.getByTestId("button-open-browser").click(); await page.getByTestId("button-take-browser-control").click();
  await expect(page.getByText("You have control")).toBeVisible();
  fixture.status.pages[0].document_epoch++; fixture.status.controlling = false;
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  fixture.unknown(); await page.getByTestId("button-take-browser-control").click();
  await expect(page.getByText("You have control")).toBeVisible();
  await page.getByLabel("Text to send to browser").fill("once"); await page.getByRole("button", { name: "Send text", exact: true }).click();
  await expect(page.getByText(/The action may have happened/)).toBeVisible();
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  expect(fixture.commands.filter((command) => command.command === "viewer.input")).toHaveLength(1);
});

test("closing during grant creation discards the late grant instead of opening a hidden browser", async ({ page }) => {
  let resume!: () => void; const delayGrant = new Promise<void>((resolve) => { resume = resolve; });
  const fixture = await viewerFixture(page, { delayGrant });
  await page.getByTestId("button-open-browser").click(); await expect(page.getByTestId("browser-assistance-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close view", exact: true }).click(); resume();
  await expect.poll(fixture.closed).toBe(1);
  expect(fixture.commands.some((command) => command.command === "viewer.open")).toBe(false);
});

test("a late first open cannot reset a second open that is still waiting for its grant", async ({ page }) => {
  const fixture = await viewerFixture(page);
  let first!: () => void; let second!: () => void; let count = 0;
  const pending = [new Promise<void>((resolve) => { first = resolve; }), new Promise<void>((resolve) => { second = resolve; })];
  await page.route("**/api/eval-jobs/987654/browser/viewers", async (route) => {
    const index = count++; await pending[index];
    await route.fulfill({ json: { viewerId: index === 0 ? "8d57271e-9fae-4c4c-b82a-03604cf402ba" : "8d57271e-9fae-4c4c-b82a-03604cf402bb" } });
  });
  try {
    await page.getByTestId("button-open-browser").click(); await expect.poll(() => count).toBe(1);
    await page.getByRole("button", { name: "Close view", exact: true }).click();
    await page.getByTestId("button-open-browser").click(); await expect.poll(() => count).toBe(2);
    first(); await expect.poll(fixture.closed).toBe(1);
    await expect(page.getByText("Opening secure view", { exact: true })).toBeVisible();
    second(); await expect(page.getByTestId("browser-frame")).toBeVisible();
  } finally { first(); second(); }
});

test("public/borrowed job viewers do not query or receive the live browser UI", async ({ page }) => {
  const fixture = await viewerFixture(page, { authorized: false });
  await expect(page.getByText("Browser fixture")).toBeVisible();
  await expect(page.getByTestId("button-open-browser")).toHaveCount(0); expect(fixture.commands).toHaveLength(0);
});

for (const cancellationDelivery of ["pending", "acknowledged"] as const) {
  test(`active cancellation explains ${cancellationDelivery} delivery without claiming the browser has exited`, async ({ page }) => {
    await viewerFixture(page, { cancellationDelivery });
    await page.getByTestId("button-cancel-job").click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("A disconnected agent may keep operating");
    await confirmation.getByRole("button", { name: "Cancel job", exact: true }).click();
    if (cancellationDelivery === "pending") {
      await expect(page.getByText("Job cancelled; agent stop pending", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Notifications (F8)").getByText(/Heartbeats will retry delivery/)).toBeVisible();
    } else {
      await expect(page.getByText("Job cancelled", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Notifications (F8)").getByText(/This confirms receipt, not that every browser process has exited/)).toBeVisible();
    }
  });
}

test("small-screen viewers can enter a verification code with a native text field", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await viewerFixture(page); await page.getByTestId("button-open-browser").click(); await page.getByTestId("button-take-browser-control").click();
  const field = page.getByLabel("Text to send to browser"); await expect(field).toBeVisible(); await field.fill("654321");
  await page.getByRole("button", { name: "Send text", exact: true }).click();
  await expect.poll(() => fixture.commands.filter((command) => command.command === "viewer.input").length).toBe(1);
  const dialog = page.getByTestId("browser-assistance-dialog"); const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
});
