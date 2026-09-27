# OAuth login as a plugin

**Date:** 2026-09-27 · **Status:** approved (decisions below chosen by the user)

## Goal

GitHub and Google sign-in move out of Core into one optional `oauth` plugin, enabled
through `VOX_PLUGINS`. Production (vox.agora.build) keeps GitHub sign-in working
throughout and gains Google once its credentials exist.

## Decisions

- **One plugin, both providers.** Each provider switches on only when its
  credentials are set (`GITHUB_CLIENT_ID`+`GITHUB_CLIENT_SECRET`,
  `GOOGLE_CLIENT_ID`+`GOOGLE_CLIENT_SECRET`). Env names are unchanged.
- **Account links live in the plugin's own schema** (`plugin_oauth.identities`),
  the organizations-extraction pattern. Core's `users.github_id` / `users.google_id`
  are frozen — no code reads or writes them — and are dropped in a later release.

## Why Core needs a service for plugins

Signing someone in means finding or creating a Core user and starting a Core
session. Plugins only own their own schema, and until now Core offered plugins
no services (only plugins offered them to Core). So:

- **Plugin API 1.1.0:** `loadPlugins` accepts services from Core and registers them
  before any plugin activates; the activation-order resolver treats them as
  satisfied. Plugins declaring `^1.0.0` still load.
- **`vox.identity@1.0.0`** (contract in `@vox/plugin-sdk`), implemented by Core:
  `getUserById`, `getUserByEmail`, `createUser`, `markEmailVerified`, `signIn`,
  `signOut`. Core keeps sole ownership of users and sessions; the plugin never
  writes Core tables.

## The plugin

- Routes under `/api/plugins/oauth/`: `GET providers`, `GET github/start`,
  `POST github/callback`, `GET google/start`, `GET google/callback`.
- **Linking rules are unchanged:** match by provider account → else link to the
  user with that email (refused if that user is already linked to a *different*
  account on the same provider) → else create a user. Disabled accounts are refused.
  Both providers keep the anti-forgery `state` check.
- **Google drops Passport** for the same direct code exchange GitHub already uses,
  and requires Google to report the email as verified. Passport was only used for
  Google, so Core drops it and `passport-google-oauth20` entirely.
- **Callback URLs.** GitHub's registered callback is the web page
  `/auth/github/callback`, which then calls the plugin — so production's registered
  GitHub callback does not change. Google's is
  `https://vox.agora.build/api/plugins/oauth/google/callback` (never registered
  before; production has no Google credentials yet).

## Data move

`0002_copy_from_core.sql` copies every non-null `users.github_id` / `users.google_id`
into `identities`, then asserts the counts match — a mismatch aborts the migration and
the app refuses to start (fail closed). Fresh databases without those columns are a
no-op. A sign-in on the old container after the copy is not lost for good: the next
sign-in re-links by email.

## Client

The login page asks `GET /api/plugins/oauth/providers` which buttons to show. With the
plugin absent that is a 404 and both buttons disappear — no dead buttons.

## Production rollout

1. Merge **after** adding `oauth` to `VOX_PLUGINS` on Coolify
   (`credits,shared-agents,organizations,oauth`). Setting it earlier is harmless to
   the running container but would stop an *old* build from restarting (unknown
   plugin id stops startup), so do it right before the merge.
2. Deploy stop-then-start, as for organizations.
3. Verify: `GET /api/plugins` lists `oauth`; `GET /api/plugins/oauth/providers`
   returns `github: true`; GitHub sign-in works.
4. Google: once a Google OAuth client exists with the redirect URI above, add
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on Coolify and redeploy.
