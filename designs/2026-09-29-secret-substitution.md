# Secret substitution — one design for web and phone

Status: **confirmed 2026-09-29, in build (PR #195).** Grew out of PR #195 (phone jobs
did not fill `${secrets.*}` at all, so `call.dial number: ${secrets.X}` failed).

## In short

- **Brokered secrets (strict isolation).** High-risk credentials — logins,
  API keys used by `restful.request` — never leave Vox's server. A broker
  performs the sensitive action server-side and returns only a safe result: a
  logged-in session (auth-session broker) or a redacted response (REST broker).
- **Runtime secrets (agent-side filling).** Ordinary secrets are sent to the
  eval agent running the job. The agent replaces `${secrets.*}` (and
  `${config.*}`) with the real values just before the run; then **aeval**
  (web) or **DialF** (phone, followed by `aeval analyze`) receives the finished
  script and runs it. Neither ever sees a placeholder.
- **"Only when trusted" (guardrail).** The eval set is the conversation in the
  middle of every job, and anyone may run a public eval flow with an eval set
  they wrote. So secrets are filled into the eval set only when its author
  could already have written the same references into the eval flow's Setup:
  same secret owner (the person, or the organization) **and** the eval set's
  owner can edit the eval flow. An untrusted eval set that
  references a secret is blocked — by Vox before the job is created, and by
  the agent as a second line.
- **Organizations use organization secrets only.** An org eval flow gets the
  org's secrets; no personal secret is ever involved, and a personal eval set
  never receives org secrets.
- **No secret value is printed, logged, or stored** anywhere Vox controls:
  logs, job errors, results, or uploaded artifacts.

## Terms

- **Eval flow** — who is tested and how to reach them: platform, and the
  **Setup/Teardown** steps (log in; or `call.dial` + `call.wait_answered` …
  `call.hangup`). Its owner's secrets are the ones used.
- **Eval set** — what to say: `config.scenario`, the conversation script.
- A job runs **Setup (eval flow) → scenario (eval set) → Teardown (eval flow)**.

## Two kinds of secret

```
                          Secrets of the eval flow's owner
                 ┌──────────────────────────┴──────────────────────────┐
          Runtime secrets                                     Brokered secrets
        (brokerType = null)                        (brokerType = auth-session | restful)
     sent to the eval agent                             never leave Vox's server
```

Secrets follow eval flow ownership: a personal eval flow uses its owner's
secrets; an org eval flow uses the org's, released only when the person who
started the job is a member of that org.

## The trust rule

**An eval set gets the secrets only if its author could already have put the
same references into the eval flow's Setup.** Two conditions, both required:

1. **Same secret owner.** The secret owner of an eval flow or eval set is its
   organization when it has one, otherwise its owner — the same scope the
   secrets endpoint already uses (org eval flow → org secrets only; personal
   eval flow → the owner's personal secrets).
2. **The eval set's owner can edit the eval flow**, now:
   `isOwnerOrOrgManager(evalSetOwner, evalFlow)` — the flow's owner, or an
   org owner/admin of the flow's org (membership looked up at job creation).

```
evalSetMayUseSecrets(evalFlow, evalSet) =
      secretOwner(evalSet) == secretOwner(evalFlow)
  AND isOwnerOrOrgManager(owner of evalSet, evalFlow)
where secretOwner(x) = x.organizationId != null ? org(x.organizationId) : user(x.ownerId)
```

Why the second condition: any org member may create an org-owned eval set,
including a plain member who can neither see org secret values nor edit the
org's eval flows. Without it, such a member could write
`${secrets.ORG_KEY}` into an org eval set and run it against the org's eval
flow. With it, everyone who can edit a trusted eval set (its creator, and the
org's managers) could have edited the eval flow's Setup anyway.

| Eval flow (secrets used) | Eval set | Gets the secrets? |
|---|---|---|
| mine, personal (my secrets) | mine, personal | yes |
| mine, personal | owned by an org, even created by me | **no** |
| mine, personal | a colleague's personal set | **no** |
| org A (org A's secrets) | owned by org A, created by the flow's owner | yes |
| org A | owned by org A, created by an org A owner/admin | yes |
| org A | owned by org A, created by a plain member | **no** |
| org A | any personal set, even the flow owner's | **no** |
| anyone's | a stranger's public set | **no** |

Checked when the job is created, against the eval set as it is then — the job
keeps its own copy of the scenario, so later edits cannot change what an
approved job runs. If the organizations service fails, the check fails (the
run is refused with an error, a schedule tick is skipped, never disabled),
like the rest of the secret gate.

Setup/Teardown always get the secrets — they are the eval flow's own steps.
`${config.*}` is filled everywhere (it is the eval flow's config, not a secret
store); a config value that itself contains `${secrets.K}` is still subject to
the rule, because secrets are filled after config.

## Vox server (job creation)

1. **One gate, every path.** `secretRefsError(evalFlow, evalSet)`
   (`server/auth-session.ts`) returns an error or null:
   - an untrusted eval set referencing `${secrets.*}` →
     *"The eval set uses secret(s) X, but it belongs to someone other than this
     eval flow's owner. An eval set may use the eval flow owner's secrets only
     when the same person or organization owns both."*
   - otherwise, a referenced secret missing from the owner's scope → the
     existing "not configured for its owner" message.

   Run by every path that creates a job or arms one: console run route,
   `/api/v1` run, schedule create, schedule enable, schedule run-now, and the
   scheduler tick (which disables the schedule with the message, as it does
   for missing secrets today). The run dialog's secret list uses the same
   narrowing.
2. **One stamp.** `mergeEvalConfig(flowConfig, setConfig, { evalSetSecrets })`
   — the single function every path uses to build a job's config — strips any
   `evalSetSecrets` either config carries and stamps the server's answer
   (strip-then-stamp, like `sessionInjection`). The TypeScript signature makes
   the stamp mandatory, so no path can forget it.

## Eval agent (one prepare step for every job)

```
 fillJob(job)                                          vox_eval_agentd/placeholders.ts
   1. GET /jobs/:id/secrets ──► runtime secrets
   2. parse scenario, Setup, Teardown (YAML → values)
   3. fill ${config.*}, then ${secrets.*}
        · Setup + Teardown       — always
        · scenario (eval set)    — only if the job says evalSetSecrets: true
        · restful.request steps  — never (Vox's server fills them)
   4. remember the secret values for redaction
        │
        ├── web:   auth-session injection (if stamped) → YAML → aeval run
        └── phone: restful.request via Vox → DialF job.run → aeval analyze
        │
   5. unresolvedSecretsError(): anything left in what will run?
        · untrusted eval set referencing a secret → the untrusted message
        · a secret the server did not supply      → names it
   6. job error → secret values redacted          (processJobs, one place)
```

- **Parsed values, not YAML text.** `number: ${secrets.X}` and
  `number: "${secrets.X}"` both work. (Today web pastes a quoted value into the
  text, so the quoted form breaks YAML on web.) A part with nothing to fill is
  passed on byte-for-byte; a filled part is re-written as YAML — web already
  re-writes Setup + scenario + Teardown when composing them.
- **Step 5 runs after web session injection**, which removes brokered login
  references legitimately.
- **Redaction:** raw value, YAML-escaped form and URL encodings, applied to
  every job error in one place, plus aeval output as today.

### Web vs phone after this change

| | Web | Phone |
|---|---|---|
| Filling code | `fillJob` → `placeholders.ts` | same |
| Setup / Teardown | filled | filled |
| Scenario (eval set) | filled when trusted | filled when trusted |
| Brokered login | auth-session broker → session | — |
| Brokered API call | not supported (`restful.request` is phone-only) | REST broker |
| Unresolved check + message | shared | shared |
| Error redaction | one place | same place |

## No secret value printed, logged, or stored

Secret **names** may appear (e.g. "secret AGENT_PHONE is not configured") —
they are needed to fix a run and are not secret. Secret **values** never:

| Where | Today | After |
|---|---|---|
| Vox server logs | counts only; a name on a decrypt failure | unchanged (audited) |
| Agent logs | counts only | unchanged |
| Job errors (stored, shown in the console) | web: aeval failures redacted; phone: **not** — a bad `call.dial` number is echoed | every job error redacted in one place |
| Uploaded artifacts | phone: DialF `steps.json` records the dialed number, `call.json` the far-end number; web: aeval's output may hold a copy of the filled scenario | every text artifact (`.json`, `.yaml`, `.yml`, `.log`, `.txt`, `.csv`) scrubbed of secret values before upload, in one place; audio untouched |
| `callMetadata` | far-end number reduced to last 4 digits | unchanged |
| Temp files with filled YAML | written `0600`, deleted after the run | unchanged |
| REST broker responses | redacted by Vox's server | unchanged |

Outside Vox's control: `dialfd` on the phone host keeps its own logs and
recordings, and the target platform sees whatever the script sends it. Both
are on hosts the eval flow's owner or the agent's operator already controls.

## Rollout and compatibility

- **Server first** (deploys on merge): new jobs carry the stamp, and the gate
  already blocks untrusted references — so even an agent that is not upgraded
  yet never receives a job that would leak.
- **A job without the stamp** (created before the deploy) is treated as
  untrusted by a new agent: its eval set is not filled. A queued job whose
  trusted eval set uses secrets would fail with the untrusted message; rare,
  and re-running it fixes it.
- **Behaviour change:** a public eval set that uses `${secrets.X}` stops
  working for people who do not own the eval flow. They get the message above
  before any job is created.
- Agents need `./scripts/vox-upgrade.sh`, including the phone host (which also
  gets the original `call.dial` fix).

## Tests

- `placeholders.ts`: Setup/Teardown filled; scenario filled only with
  `evalSetSecrets`; quoted and bare forms; `${config.*}` → `${secrets.*}`
  order; restful steps untouched and not required; unsupplied names; the
  untrusted message; a secret value containing `${secrets.X}` is not flagged.
- Phone end to end through `runPhoneJob` with filled steps: DialF receives the
  real number.
- Artifacts: a secret value in a DialF `steps.json` / aeval output file is
  gone after the scrub; audio files are untouched.
- Server: `evalSetMayUseSecrets` for every row of the table; `mergeEvalConfig`
  strips a caller's `evalSetSecrets` and stamps the answer; the run route and
  `/api/v1` refuse an untrusted eval set that references a secret, and accept
  the same eval set when the flow owner owns it.
- Each test mutation-checked; full gate; agent Docker image built locally.

## Decided

- Organizations: org secrets only; only org-owned eval sets get them.
- A personal eval set written by another member of the org is **not**
  trusted, and neither is a personal set of the flow's owner on an org flow.
- An org-owned eval set is trusted only if its creator can edit the eval flow
  (the flow's owner, or an org owner/admin).
