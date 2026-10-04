# notifications - Plugin Spec

Optional notification channels, content, and automation, enabled by
`VOX_PLUGINS=notifications`. Plugin version 1.1.0; API ^1.1.0.
Provides `vox.notifications@1.0.0`; requires Core's `vox.encryption`.
Core still owns verification codes, replay protection, OAuth, and authentication.
The plugin never treats a Discord message or an LLM result as verification.

## UI and HTTP

Lazy `/console/notifications`, linked from personal Settings only when enabled.
Tabs: Channels, Rules & Content, Activity, and admin-only Access & Groups.
No credits/payment dependency for delivery or navigation; organization billing
and organization membership are unchanged.

- `GET /api/plugins/notifications/settings` - capabilities, readiness and visible audiences.
- `GET /api/plugins/notifications/channels` - own/assigned channel metadata, never destinations.
- `POST /api/plugins/notifications/channels` - add own or assigned-group email/Discord channel.
- `PATCH /api/plugins/notifications/channels/:id` - revision-bound update/pause, optional secret rotation.
- `GET /api/plugins/notifications/rules` - own/assigned rules and evaluation errors.
- `POST /api/plugins/notifications/rules` - editor creates content and an audience-scoped rule.
- `PATCH /api/plugins/notifications/rules/:id` - revision-bound edit/enable/pause.
- `POST /api/plugins/notifications/preview` - evaluates one audience member, never sends.
- `GET /api/plugins/notifications/activity` - authorized triggers and delivery status, not payloads.
- `GET /api/plugins/notifications/access` - admin editor/group grants and audit history.
- `POST /api/plugins/notifications/access` - admin sets explicit edit/JavaScript/LLM grants.
- `POST /api/plugins/notifications/groups` - admin defines an audience of at most 100 users.
- `PATCH /api/plugins/notifications/groups/:id` - admin replaces membership, removing stale targets.

Routes require an enabled authenticated account. Access and group changes also
require Core admin. "Scout / Editor" is an explicit admin-assigned notification
permission, not a username, subscription, Principal/Fellow tier, or admin role.
Editors manage their own personal rules and specifically assigned groups only;
JavaScript and LLM permissions are separately assigned. Group access allows
reading numeric monitoring data and routing alerts for current members: grant
only to trusted editors. Audience groups belong to this plugin, not organizations.
Ordinary users can manage their personal destinations, inspect their alerts,
and see their incoming personal rules, but cannot change rule content/conditions.

## Sources and rules

Optional Core `vox.users` supplies the user directory for automation and routes.
Without it, security email delivery still works but account routes are unavailable.
Optional Core `vox.notification-data` supplies a numeric personal snapshot and
the newest 50 samples from at most 100 recent personal eval jobs; raw data, artifacts, recordings, names,
transcripts and organization jobs are excluded. Optional `vox.credits` adds
`credits.available`. No direct reads of Core or another plugin's tables.

Built-in metrics: credits.available, jobs.failed24h, jobs.completed24h,
jobs.running, eval.responseLatencyMs, eval.turnSuccessRate (0..1). Latest eval
metrics are null when unavailable; comparisons with missing values never match.
Sources can be extended through the SDK data seam.

One condition per rule:

- Compare latest numeric metric using `<`, `<=`, `=`, `!=`, `>=`, or `>`.
- JavaScript executes in QuickJS WASM with an independent context/runtime,
  50 ms CPU deadline, 8 MB heap and 256 KB stack. Only supplied `data`, `latest`,
  and `loadData()` (a copy of the same bounded snapshot) exist. No Node, files,
  environment, database, network, imports or host callbacks. Return a boolean
  or `{matched:boolean,summary:string}` with at most 300 summary characters.
- LLM instructions use a server-configured Anthropic provider at a fixed HTTPS
  endpoint. Editors cannot set provider URLs, keys, models or tools. Numeric
  metrics and at most 20 numeric samples go to the external provider; no user
  names, emails or raw recordings/transcripts are automatically added. Editors
  must not include secrets or personal data in their free-text instructions.
  The result must validate against
  the same strict structured schema; a model/provider error does not trigger.

Checks run at least every 60 seconds per target, subject to worker capacity;
LLM rules require at least 15 minutes. New rules default paused. A changed data
fingerprint is required for reevaluation, avoiding duplicate calls/alerts on an
unchanged sample. Alerts fire on a match/recovery edge, or on new matched data
after the configured cooldown (minimum 5 minutes). Preview never delivers,
but LLM previews consume the same instance-wide daily budget as scheduled runs.
Templates are plain text with `{{username}}`, `{{rule}}`, `{{result}}`, and
numeric metric-key placeholders. Output is bounded; Discord mentions are off.

## Delivery and safety

Email targets each recipient's current verified account address, never an
editor-supplied email. Discord accepts only official discord.com/discordapp.com
HTTPS webhook paths, with no userinfo, custom port, query, fragment or redirects.
Webhook URLs and message bodies are encrypted with Core `vox.encryption`.
Discord/LLM secrets and provider response/errors are not logged or returned.

Workers claim individual state/delivery rows with short transactions and durable
60-second leases. No pool connection or row lock spans SMTP or external LLM/HTTP
calls. Workers support replicas; idempotent outbox writes happen in the same
transaction as state/event updates. Queued rule messages recheck enabled account,
rule revision, permission, channel revision, current audience membership, and
email before sending. Revocation, removal, pause or a destination change cancels
stale queued messages. A send already in flight cannot be recalled.
Ticks process bounded batches, up to 20 evaluations / 10 deliveries within a
2.5-second work budget (a single external call can run to its timeout). Core
security emails take priority over automation messages, avoiding code expiry
behind an alert backlog. Capacity is best-effort, not a real-time scheduler SLA.
Configuration/audience edits reset target state for fresh evaluation; resuming
only a channel does not replay old expired alerts.

Retries back off up to 5 minutes and stop after 5 attempts or expiry. Payloads
are scrubbed on delivered/failed/expired state. Security codes retain Core expiry;
rule alerts expire after 24 hours. `sendEmail` means durably queued, not confirmed
delivery. SMTP/Discord can produce duplicates if a process dies after a remote
send but before acknowledgment; neither protocol provides exactly-once delivery.
Failed evaluations retry after 15 minutes and expose a sanitized configuration
error to authorized editors. Audit records retain actor/action/object, not secrets.

Owns plugin_notifications: deliveries, channels, rules, rule_states, events,
editor_permissions, audience_groups, audit_log, llm_daily_budget.
Disablement loads no UI/workers/routes and retains data; expired messages are
scrubbed, never sent, when re-enabled. Audit/history records are retained so far.

## Configuration and validation

Email: SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (false), SMTP_USER, SMTP_PASSWORD,
NOTIFICATIONS_FROM, SMTP_REQUIRE_TLS (true). Core CREDENTIAL_ENCRYPTION_KEY is
required for channels/automation. Discord needs no global bot credential.
WhatsApp/SMS are future adapters, not enabled or approved verification methods.

Opt-in LLM: NOTIFICATIONS_LLM_PROVIDER=anthropic, NOTIFICATIONS_LLM_API_KEY,
NOTIFICATIONS_LLM_MODEL (explicit model id), NOTIFICATIONS_LLM_DAILY_LIMIT
(default 100 requests/day UTC, 0 disables, maximum 10000). A DB counter reserves
budget before each provider call, including failures and previews. 256 output
tokens and a ten-second timeout are fixed. This bounds request count/output,
not a precise currency budget; use provider-side spending limits as well.

Tests: notifications-rules.test.ts covers comparisons, templates, destinations
and sandbox limits. notifications-automation.test.ts uses an opt-in disposable
local vox_notifications_test DB (TEST_NOTIFICATIONS_DATABASE_URL); it mocks
SMTP/provider I/O but exercises PostgreSQL leases, permissions and Core snapshots.
tests/e2e/notifications.spec.ts covers UI permissions, preview, disablement and
mobile overflow. Never run integration fixtures against shared/production data.
