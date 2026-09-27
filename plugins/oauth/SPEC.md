# oauth — Plugin Spec

## Identity
- id: `oauth`
- version: 1.0.0
- voxPluginApi: ^1.1.0 (needs Core-provided services, added in 1.1.0)

## Function and non-goals
Sign in with GitHub and Google. One plugin, both providers; each provider is on
only when its client ID and secret are set. It resolves a provider account to a
Vox user and starts a session — nothing else. Non-goals: password login,
registration, invites and activation (all Core); user and session storage (Core
owns both; this plugin reaches them only through `vox.identity`); other
providers (add one to `server/providers.ts` and to the `identities.provider`
CHECK).

## Services provided and consumed
- Provides: none.
- Consumes: `vox.identity@^1.0.0`, provided by **Core** (not a plugin):
  `getUserById`, `getUserByEmail` (case-insensitive), `createUser`,
  `markEmailVerified`, `signIn` (regenerates the session), `signOut`.

## HTTP and WebSocket URLs
Under `/api/plugins/oauth/`:
- `GET providers` → `{ github: boolean, google: boolean }` — the login page uses
  it to decide which buttons to show (404 when the plugin is off → no buttons).
- `GET github/start` → 302 to GitHub. `POST github/callback` `{ code, state }` —
  called by the Core web page `/auth/github/callback`, which is the URL
  registered with GitHub.
- `GET google/start` → 302 to Google. `GET google/callback` — Google redirects
  the browser here directly; success → `/console`, failure →
  `/login?error=oauth_failed`.

## Web UI contributions
None of its own. Core's login page and `/auth/github/callback` page call the
routes above.

## Dependencies and minimum versions
Core with plugin API ≥ 1.1.0 (for `vox.identity`). No other plugins.

## Environment variables
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL` (default
`<origin>/auth/github/callback`); `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_CALLBACK_URL` (default `<origin>/api/plugins/oauth/google/callback`).
Set the callback URLs explicitly in production.

## Database configuration
Schema `plugin_oauth`, one table:
`identities (provider, subject, user_id, created_at)` —
`PRIMARY KEY (provider, subject)`, `UNIQUE (provider, user_id)`, provider in
`('github','google')`. `user_id` is a Core user id held as an opaque integer
(no cross-schema FK, as in organizations).

## Data ownership
Owns the link between an external account and a Vox user. Core owns users and
sessions. Core's `users.github_id` / `users.google_id` are frozen: no code reads
or writes them; they are dropped in a later release.

## Permissions
All routes are public (they are how an anonymous visitor signs in). Nothing
here grants roles; a signed-in user has exactly the permissions Core gives them.

## Workers
None.

## Enablement and disabled behavior
Enabled by adding `oauth` to `VOX_PLUGINS`. Disabled: the login page shows no
provider buttons; password login is unaffected; links in `plugin_oauth` are kept
and used again on re-enable. If GitHub/Google credentials are set while the
plugin is off, Core logs a startup warning.

## Migrations and upgrades
- `0001_init.sql` — the `identities` table.
- `0002_copy_from_core.sql` — one-shot copy of every `users.github_id` /
  `users.google_id` into `identities`, then checks counts and values match;
  any mismatch aborts the transaction and the app refuses to start. A database
  with neither column (fresh install) is a no-op; one with only one of them is
  refused as inconsistent. Migrations are checksummed: never edit one after it
  has run anywhere — add a new one.

## Health and operations
`GET /api/plugins/oauth/health` → `ok` when the `identities` table is readable.
`GET /api/plugins/oauth/providers` shows which providers are on. Sign-in
failures are logged at warn level with the provider's error, never the code or
tokens.

## Security and data retention
- Account linking, in order: an existing link for this provider account → else
  the user with that email (case-insensitive) → else a new user. Linking by
  email is refused when that user is already linked to a *different* account
  on the same provider (account takeover), and when the user's email is
  unverified *and* the account has a password (pre-hijacking). Disabled users
  are refused.
- Only provider-verified emails are used: GitHub's primary verified address from
  `/user/emails` (the profile's public `email` carries no verified flag and is
  ignored); Google requires `email_verified: true`.
- Anti-forgery `state`: random, stored on the session, single-use, bound to its
  provider.
- `signIn` regenerates the session (no session fixation). Starting a sign-in
  signs out whoever was signed in on that session.
- Client secrets never reach the browser; the code exchange is server-side.
- Link inserts are race-safe: `INSERT … ON CONFLICT DO NOTHING RETURNING`; a
  request whose insert lost signs in only if the winning row is the same user
  and account.

## Failure modes
- Provider down / bad code → the sign-in fails (401 for GitHub, redirect to
  `/login?error=oauth_failed` for Google); nothing is written.
- `createUser` succeeds but the link insert loses a race → the account resolves
  to whoever won; the created user is left unlinked (harmless, unreferenced).
- A link whose Core user was deleted → the link is dropped and the sign-in
  re-resolved by email.

## Drain procedure
Nothing to drain: no workers and no in-flight state beyond a single-use
`state` value on the visitor's own session.
