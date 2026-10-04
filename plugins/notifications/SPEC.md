# notifications - Plugin Spec

Optional message delivery, enabled by `VOX_PLUGINS=notifications`.
Provides `vox.notifications`; consumes Core's `vox.encryption`.
Core owns verification codes and whether verification succeeds. This plugin
does not authenticate users, grant permissions, or verify codes.

Owns `plugin_notifications.deliveries`: encrypted email payload, idempotency
key, expiry, attempts and delivery status. A singleton worker retries with
backoff, at most five attempts, and never sends an expired message. Payloads
are scrubbed after delivery, failure or expiry; codes and SMTP errors are not
logged. SMTP cannot guarantee exactly-once delivery after a network failure.

Email is the first adapter. Discord, WhatsApp and SMS are future adapters,
not automatically approved verification methods. No HTTP routes or UI.

Configuration: `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE` (false),
`SMTP_USER`, `SMTP_PASSWORD`, `NOTIFICATIONS_FROM`, `SMTP_REQUIRE_TLS` (true).
`CREDENTIAL_ENCRYPTION_KEY` is supplied through Core's encryption service.
Without email configuration or encryption the service reports email unavailable;
TOTP remains usable. Health checks database availability. Disablement retains
audit records and pauses retries; expired deliveries are never sent on re-enable.
