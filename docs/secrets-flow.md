# Secrets Flow Design

How secrets are stored, fetched, and resolved across Vox's two runner systems.
For eval jobs (web and phone), the full design — brokered vs runtime secrets,
the "only when trusted" eval-set rule, and redaction — is
`designs/2026-09-29-secret-substitution.md`.

## Overview

Both runners follow the same pattern: user stores encrypted secrets in the Vox UI, the runner fetches them on-demand via a dedicated API endpoint authenticated with a Bearer token, and resolves `${secrets.KEY}` placeholders before executing browser automation.

## Comparison

| Step | Eval Agentd | Clash Runner |
|---|---|---|
| **1. Store secrets** | User stores in `/console/secrets` -> AES-256-GCM -> `secrets` table; values must be at least 4 characters (and each line of a multi-line value that has letters or digits) | Same |
| **2. Placeholders** | `${secrets.KEY}` in the eval flow's Setup/Teardown YAML, and in the eval set's scenario only when the eval set is trusted | `${secrets.KEY}` in profile setup steps JSON |
| **3. Name validation** | `^[A-Z][A-Z0-9_]*$` (`shared/secrets.ts`) | Same |
| **4. Token type** | `ev...` (eval agent token) | `cr...` (clash runner token) |
| **5. Work unit** | Eval job (manual or cron) | Clash match (event -> scheduler assigns) |
| **6. Claim/assign** | `POST /api/eval-agent/jobs/:id/claim` | Scheduler sets runner state=assigned |
| **7. Auth helper** | Inline: hash token -> `evalAgentTokens` -> check `isRevoked` | `authenticateClashRunner()`: hash token -> `clashRunnerIssuedTokens` -> check `isRevoked` -> look up runner in pool |
| **8. Secrets endpoint** | `GET /api/eval-agent/jobs/:jobId/secrets` | `GET /api/clash-runner/secrets?matchId=X` |
| **9. Ownership guard** | Job must be `running` + `job.evalAgentId` -> `agent.tokenId` must match | Runner must be `running` + `runner.currentMatchId` must match |
| **10. Owner chain** | job -> eval flow -> org secrets (org eval flow, fenced by the job creator's membership) or `eval flow.ownerId`'s personal secrets | match -> event -> `event.createdBy` |
| **11. Decrypt** | `decryptValue()` per secret, log errors | Same |
| **12. Response** | `{ "KEY": "value", ... }` | Same |
| **13. Audit log** | `[Secrets] Job N: found N secret(s) for eval flow owner` | `[ClashSecrets] Runner X fetched secrets for match #N (event #N, owner #N): N decrypted, N failed` |
| **14. Resolution** | `placeholders.ts` fills parsed YAML values (`${config.*}` then `${secrets.*}`), never `restful.request` steps | `browser-agent.ts` replaces in setup step values (plain) |
| **15. Regex** | `[A-Z][A-Z0-9_]*` (aligned with `shared/secrets.ts`) | Same |
| **16. Execution** | aeval (web) or DialF + `aeval analyze` (phone) | Playwright `pressSequentially()` |
| **17. Revocation** | Checked on secrets fetch (inline) | Checked on all endpoints via `authenticateClashRunner()` |

## Secrets Lifecycle

```
User -> /console/secrets -> POST /api/secrets
  |
  v
secrets table (encrypted with AES-256-GCM, requires CREDENTIAL_ENCRYPTION_KEY)
  |
  v
Runner authenticates with Bearer token (ev.../cr...)
  |
  v
Server validates: token not revoked, runner owns the active job/match
  |
  v
Server resolves owner: job -> eval flow -> ownerId  OR  match -> event -> createdBy
  |
  v
Server fetches user's secrets, decrypts each with decryptValue()
  |
  v
Returns { "KEY": "value", ... } (plaintext over HTTPS)
  |
  v
Runner resolves ${secrets.KEY} placeholders in config (YAML or JSON setup steps)
  |
  v
Browser automation executes with real credentials
```

## Secret Name Convention

- Pattern: `^[A-Z][A-Z0-9_]*$`
- Examples: `AGORA_CONSOLE_EMAIL`, `AGORA_CONSOLE_PASSWORD`, `API_KEY`
- Defined in: `shared/secrets.ts` (source of truth)
- Imported by both runners (`vox_eval_agentd/placeholders.ts`, `vox_clash_runner/browser-agent.ts`); their images copy `shared/secrets.ts` in

## Security Model

- Secrets are encrypted at rest (AES-256-GCM) and require `CREDENTIAL_ENCRYPTION_KEY` env var
- Secrets are transmitted over HTTPS only
- Endpoints enforce: valid token, token not revoked, active job/match ownership
- Audit logs record who fetched, when, for which job/match (never the secret values)
- Revocation takes effect immediately on next API call from the runner
- The runner container itself is trusted with plaintext secrets (inherent to browser automation)
- Brokered secrets (logins, `restful.request` API keys) never reach a runner: a broker acts server-side
- Eval jobs: an eval set gets the eval flow's secrets only when trusted (same secret owner, and its owner can edit the eval flow) — checked by the server on every job-creating path (`secretGate`)
- Eval jobs: secret values are redacted from aeval's logged output and every job error, and scrubbed from every artifact before upload; a job using a secret shorter than 4 characters is refused

## Key Files

| File | Role |
|---|---|
| `shared/secrets.ts` | `SECRET_NAME_PATTERN`, `SECRET_PLACEHOLDER_REGEX`, `resolveSecretPlaceholders()` |
| `server/routes.ts` | Secret validation on create, `/api/eval-agent/jobs/:id/secrets`, `/api/clash-runner/secrets`, `authenticateClashRunner()` |
| `server/storage.ts` | `encryptValue()`, `decryptValue()`, `getSecretsByUserId()` |
| `server/auth-session.ts` | `secretGate()` / `evalSetMayUseSecrets()` — the trust rule, run by every job-creating path |
| `vox_eval_agentd/vox-agentd.ts` | `fetchSecrets()`, `fillJob()`; error redaction and artifact scrub in `processJobs` |
| `vox_eval_agentd/placeholders.ts` | `fillJobPlaceholders()`, `unresolvedSecretsError()`, `scrubSecretsFromArtifacts()` |
| `vox_clash_runner/browser-agent.ts` | `resolveSecrets()` (plain value replacement) |
| `vox_clash_runner/clash-runner.ts` | Fetches secrets via `GET /api/clash-runner/secrets?matchId=X` |
