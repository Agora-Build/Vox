import type { BrowserAssistanceStatus, BrowserStatus } from "@shared/browser-assistance";

function reasonText(reason: BrowserAssistanceStatus["reason"]): string | null {
  switch (reason) {
    case "still_on_login": return "The evaluation tab is still on the login page.";
    case "wrong_target": return "The evaluation tab has not reached the required page.";
    case "selector_absent": return "The required page element is not visible yet.";
    case "navigation_timeout": return "The evaluation page took too long to load.";
    case "check_timeout": return "The readiness check timed out.";
    case "check_failed": return "The readiness check could not finish.";
    case "condition_not_met": return "The original readiness condition is not met yet.";
    case "browser_unavailable": return "The evaluation browser is no longer available.";
    default: return null;
  }
}

export function browserReadinessMessage(status: BrowserStatus | null): string | null {
  const assistance = status?.assistance ?? status?.last_assistance;
  if (!assistance) return null;
  const detail = reasonText(assistance.last_check_reason) ?? reasonText(assistance.reason);
  switch (assistance.state) {
    case "ready": return "Readiness confirmed. The evaluation resumed; check the job for its final result.";
    case "expired": return `Browser assistance expired before readiness was confirmed.${detail ? ` ${detail}` : ""} This wait cannot resume.`;
    case "cancelled": return "Browser assistance was cancelled. Check the job for its final result.";
    case "failed": return `Browser assistance failed.${detail ? ` ${detail}` : ""} Check the job for its final result.`;
    case "checking": return detail
      ? `${detail} aeval is retrying until the assistance deadline. Login will not be resubmitted.`
      : "Checking the evaluation tab for readiness. No login or submission will be repeated.";
    case "held": return detail
      ? `${detail} Complete the required action, then take control and choose Check & continue.`
      : "Evaluation paused for assistance. Complete the required action, then choose Check & continue.";
    case "waiting": return "The evaluation is waiting for its original readiness condition.";
  }
}
