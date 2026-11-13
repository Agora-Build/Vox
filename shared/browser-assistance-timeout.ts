import { mintTimeoutSeconds } from "./mint-timeout";

export const DEFAULT_BROWSER_ASSISTANCE_TIMEOUT_SECONDS = 120;

/** The broker also supplies its actual child budget, which can be shorter. */
export function browserAssistanceTimeoutSeconds(loginTimeoutSeconds = mintTimeoutSeconds()): number {
  const loginLimit = Math.min(mintTimeoutSeconds(), Math.max(1, Math.floor(loginTimeoutSeconds)));
  const raw = process.env.VOX_BROWSER_ASSISTANCE_TIMEOUT_SECONDS?.trim();
  let configured = DEFAULT_BROWSER_ASSISTANCE_TIMEOUT_SECONDS;
  if (raw !== undefined && raw !== "") {
    const value = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value <= 0) {
      warnOnce(`VOX_BROWSER_ASSISTANCE_TIMEOUT_SECONDS=${JSON.stringify(raw)} is not a positive whole number of seconds; using ${configured}s before applying the login limit`);
    } else {
      configured = value;
    }
  }
  if (configured > loginLimit) {
    warnOnce(`browser assistance timeout ${configured}s exceeds the login timeout ${loginLimit}s; using ${loginLimit}s`);
  }
  return Math.min(configured, loginLimit);
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[browser-assistance-timeout] ${message}`);
}
