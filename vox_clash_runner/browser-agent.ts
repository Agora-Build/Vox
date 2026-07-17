// browser-agent.ts — Launches a Playwright Chromium browser, visits an agent URL,
// and executes setup steps to start the voice session.

import { chromium, type Browser, type Page } from "playwright-core";
import { SECRET_PLACEHOLDER_REGEX } from "../shared/secrets";

export interface SetupStep {
  action: "click" | "fill" | "wait" | "select" | "press";
  selector?: string;
  value?: string;
  timeout?: number;
  /**
   * Best-effort step: if `selector` never appears within `timeout`, SKIP this
   * step (no-op) instead of failing the whole run. Use for conditional UI such
   * as one-time consent modals that only show for accounts that haven't
   * accepted yet — the same step must both click the modal when present and be
   * harmless when it's already been dismissed.
   */
  optional?: boolean;
}

export interface AgentConfig {
  id: number;
  name: string;
  agentUrl: string;
  setupSteps: SetupStep[];
}

export interface BrowserAgent {
  browser: Browser;
  page: Page;
  agentConfig: AgentConfig;
}

function resolveSecrets(steps: SetupStep[], secrets: Record<string, string>): SetupStep[] {
  const secretKeys = Object.keys(secrets);
  console.log(`[BrowserAgent] Resolving secrets (${secretKeys.length} available: ${secretKeys.join(", ")})`);
  return steps.map((step) => {
    if (!step.value) return step;
    const resolved = step.value.replace(SECRET_PLACEHOLDER_REGEX, (match, key) => {
      const val = secrets[key];
      if (val !== undefined) {
        console.log(`[BrowserAgent]   Resolved \${secrets.${key}} (${val.length} chars)`);
        return val;
      }
      console.warn(`[BrowserAgent]   WARNING: \${secrets.${key}} not found in secrets`);
      return match;
    });
    return { ...step, value: resolved };
  });
}

/**
 * Launch a Chromium browser (NEW headless mode) targeting an agent's web URL.
 *
 * Must use new headless (`--headless=new`), not plain `headless: true`:
 * Playwright's old headless is the "headless shell" with NO audio stack, so the
 * agent's TTS/WebRTC voice is never rendered to the PulseAudio sink and the
 * broadcaster publishes silence. New headless runs the full Chromium (audio
 * included) without needing an X server — verified to render audio to
 * Sink_*_Out in the runner container. Mirrors voice-agent-tester.
 *
 * @param config Agent configuration (URL + setup steps)
 * @param sinkName PipeWire sink name for audio output (e.g., "Virtual_Sink_A")
 * @param sourceName PulseAudio capture source for mic input (e.g., "Mic_A").
 *   Must be a real source, NOT a `.monitor` — Chromium doesn't expose monitors
 *   as microphones, so getUserMedia would fail with NotFoundError.
 * @param secrets Decrypted secrets for placeholder resolution
 */
export async function launchBrowserAgent(
  config: AgentConfig,
  sinkName: string,
  sourceName: string,
  secrets: Record<string, string>,
): Promise<BrowserAgent> {
  console.log(`[BrowserAgent] Launching browser for "${config.name}" → ${config.agentUrl}`);
  console.log(`[BrowserAgent]   Audio out → ${sinkName}, Mic in ← ${sourceName}`);

  const browser = await chromium.launch({
    // headless:false + `--headless=new` selects Chromium's new headless mode,
    // which (unlike Playwright's default old headless) includes the audio
    // pipeline so the agent's voice reaches Sink_*_Out. See the doc comment
    // above — old headless made every agent broadcast pure silence.
    headless: false,
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream", // Auto-grant mic permission
    ],
    env: {
      ...process.env,
      PULSE_SINK: sinkName,
      PULSE_SOURCE: sourceName,
    },
  });

  const context = await browser.newContext({
    permissions: ["microphone"],
  });

  const page = await context.newPage();

  // Navigate to agent URL
  await page.goto(config.agentUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log(`[BrowserAgent] "${config.name}" page loaded`);

  // Execute setup steps with secrets resolved
  const steps = resolveSecrets(config.setupSteps as SetupStep[], secrets);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const timeout = step.timeout || 10000;
    console.log(`[BrowserAgent] "${config.name}" step ${i + 1}/${steps.length}: ${step.action} ${step.selector || ""}${step.optional ? " (optional)" : ""}`);

    // Best-effort (optional) step: if the selector never shows up within the
    // timeout, skip instead of throwing. Keeps a run alive across conditional
    // UI (e.g. a consent modal that only appears the first time an account is used).
    if (step.optional && step.selector) {
      try {
        await page.waitForSelector(step.selector, { timeout, state: "visible" });
      } catch (err) {
        // Only a visibility timeout means "not present → skip". Any other error
        // (invalid selector, page/frame closed, browser crash) is a real
        // failure and must still abort the run rather than be silently swallowed.
        if (err instanceof Error && err.name === "TimeoutError") {
          console.log(`[BrowserAgent] "${config.name}" step ${i + 1}/${steps.length}: optional selector not present — skipping`);
          continue;
        }
        throw err;
      }
    }

    switch (step.action) {
      case "click":
        if (step.selector) {
          await page.waitForSelector(step.selector, { timeout });
          await page.click(step.selector);
        }
        break;
      case "fill":
        if (step.selector && step.value !== undefined) {
          await page.waitForSelector(step.selector, { timeout });
          // Clear existing value first, then type keystroke-by-keystroke.
          // page.fill() doesn't work reliably with React controlled inputs
          // because it sets value directly without firing per-key events.
          const el = page.locator(step.selector);
          await el.click();
          await el.press("Control+a");
          await el.pressSequentially(step.value, { delay: 20 });
        }
        break;
      case "wait":
        if (step.selector) {
          await page.waitForSelector(step.selector, { timeout });
        } else if (step.timeout) {
          await page.waitForTimeout(step.timeout);
        }
        break;
      case "select":
        if (step.selector && step.value) {
          await page.selectOption(step.selector, step.value);
        }
        break;
      case "press":
        if (step.value) {
          await page.keyboard.press(step.value);
        }
        break;
    }
  }

  console.log(`[BrowserAgent] "${config.name}" setup complete — voice session should be active`);
  return { browser, page, agentConfig: config };
}

/**
 * Close a browser agent cleanly.
 */
export async function closeBrowserAgent(agent: BrowserAgent): Promise<void> {
  try {
    await agent.browser.close();
    console.log(`[BrowserAgent] "${agent.agentConfig.name}" browser closed`);
  } catch (err) {
    console.error(`[BrowserAgent] Error closing "${agent.agentConfig.name}":`, err);
  }
}
