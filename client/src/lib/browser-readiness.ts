import { supportsVerificationFlow, type BrowserAssistanceStatus, type BrowserStatus } from "@shared/browser-assistance";

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
    case "account_mismatch": return "The signed-in account does not match this flow's authorized account.";
    case "credential_continuation_required": return "Another sign-in step needs your permission to use this flow's account credentials.";
    default: return null;
  }
}

export function browserAuthenticationStage(status: BrowserStatus | null) {
  const wait = status?.assistance;
  const stage = wait?.authentication;
  if (wait?.kind !== "authentication" || !["waiting", "held", "checking"].includes(wait.state)
    || wait.remaining_seconds === 0 || !stage?.stage_id || !stage.page_id || !stage.stage_token
    || !status?.pages.some((page) => page.page_id === stage.page_id)) return null;
  return { stage_id: stage.stage_id, stage_token: stage.stage_token };
}

export function browserReadinessMessage(status: BrowserStatus | null): string | null {
  const assistance = status?.assistance ?? status?.last_assistance;
  if (!assistance) return null;
  const detail = reasonText(assistance.last_check_reason) ?? reasonText(assistance.reason);
  if (supportsVerificationFlow(status)) {
    if (assistance.state === "checking") return detail ?? "Finishing sign-in and checking the evaluation page.";
    if (assistance.state === "held" || assistance.state === "waiting") {
      const instruction = "Complete verification, then choose Sign in & continue. This lets aeval use this flow's account credentials if another sign-in step is required.";
      return detail ? `${detail} ${instruction}` : instruction;
    }
  }
  if (browserAuthenticationStage(status)) {
    return "A sign-in step is waiting. Sign in & continue authorizes aeval to enter this flow's account credentials for that step. Check & continue only checks readiness.";
  }
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
