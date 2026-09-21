# Phone vs Agent — Phase D (UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the Evaluation Mode across the console: mode selector in workflow create/edit (with the phone-number field for outbound mode), mode badges on workflow/job/result views, the phone call-detail panel on the job detail page, and the never-mixed mode switch on the realtime page.

**Spec:** `designs/2026-09-21-phone-vs-agent-design.md` §11 (UI terminology: "Evaluation Mode" is the user-facing compound — "Web vs Agent" / "Phone vs Agent"; machines branch on `transport`). Realtime: §11 "no mixed view" — a top-level mode switch, everything below unchanged within the mode; switching is a refetch (`transport=` param, Phase A). Types flow from `@shared/schema` `$inferSelect` — `workflow.transport`, `job.transport`, `result.callMetadata` need no client type additions.

## Tasks

1. **`console-workflows.tsx`** — create dialog: "Evaluation Mode" Select (Web vs Agent | Phone vs Agent) + phone-number Input shown for phone ("We call the agent at this number" → `config.phoneDial.number`; REST-trigger authoring stays API-only in v1, noted in copy); phone mode hides the web-only stepsPrefix/Suffix fields; mutation sends `transport` + `config.phoneDial`. Edit dialog: same selector + number (prefilled), PATCH sends changed `transport`/config. List rows: `📞 Phone` outline badge next to visibility for phone workflows.
2. **`console-workflow-detail.tsx` + `console-eval-jobs.tsx`** — mode badge on the header / job rows (`job.transport === "phone"`).
3. **`console-eval-job-detail.tsx`** — mode badge in the header badges row; when `result.callMetadata` present, a "Call Details" card: disposition, answer time, duration, SIM, redacted remote number.
4. **`realtime.tsx`** — top-level Evaluation Mode segmented control (Tabs) above the tier tabs, default Web vs Agent; `transport` state joins the three metric queryKeys and `params.set("transport", ...)` when phone; Phone mode shows the standard empty state when no data. Nothing else on the page changes (design §11 decision).
5. **E2E** (`tests/e2e/phone-ui.spec.ts`) — create a phone workflow through the dialog and assert the badge + persisted transport via API; realtime page: mode switch renders, switching to Phone refetches with `transport=phone` (assert via response of the page fetch or just UI state) and shows the page without error. Follow login idioms from `tests/e2e/user-roles.spec.ts`.
6. **Gate + PR** — `npm run check`, unit suite, full gate; push `feat/phone-ui-phase-d`; PR, no merge.

## Notes
- KISS: no recharts changes, no new components beyond shadcn primitives already imported per page.
- Copy uses the official term "Evaluation Mode" (§3/§11); never bare "channel".
