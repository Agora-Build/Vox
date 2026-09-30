import crypto from "crypto";
import type { Request } from "express";
import type { IdentityService, PluginDb, VoxPlugin, VoxPluginContext } from "@vox/plugin-sdk";
import { findOrLinkOrCreate, LoginRefused, type Provider } from "./link";
import { github, google } from "./providers";

// Anti-forgery state for an in-flight sign-in, kept on the Core session. Single
// use: consumed (and cleared) by the callback whether or not it matches.
type OAuthSession = { oauthState?: { provider: Provider; value: string } };
const session = (req: Request) => req.session as unknown as OAuthSession;

function beginSignIn(req: Request, identity: IdentityService, provider: Provider): string {
  // A new sign-in must not inherit whoever was signed in before.
  identity.signOut(req);
  const value = crypto.randomBytes(24).toString("hex");
  session(req).oauthState = { provider, value };
  return value;
}

async function consumeState(req: Request, db: PluginDb, provider: Provider, state: unknown): Promise<boolean> {
  const expected = session(req).oauthState;
  delete session(req).oauthState;
  // Persist the removal from the session too, so a later request on it finds
  // nothing. Fail closed: if it can't be saved, the state isn't accepted.
  const saved = await new Promise<boolean>((resolve) => req.session.save((err) => resolve(!err)));
  if (!saved || !expected) return false;
  // Single use, atomically: the PRIMARY KEY lets exactly one claim of this
  // state value succeed. Two callbacks that loaded the session at the same
  // moment both see `expected` above — only one gets past here.
  let claimed = false;
  try {
    const r = await db.query("INSERT INTO used_states (value) VALUES ($1) ON CONFLICT DO NOTHING RETURNING value", [expected.value]);
    claimed = r.rows.length === 1;
    db.query("DELETE FROM used_states WHERE used_at < now() - interval '1 day'").catch(() => {});
  } catch {
    return false;
  }
  return claimed && expected.provider === provider && typeof state === "string" && state === expected.value;
}

const origin = (req: Request) => `${req.protocol}://${req.get("host")}`;

const plugin: VoxPlugin = {
  async activate(ctx: VoxPluginContext): Promise<void> {
    const identity = ctx.services.require<IdentityService>("vox.identity", "^1.0.0");
    const { config, db, logger } = ctx;

    ctx.health(async () => {
      try {
        await db.query("SELECT 1 FROM identities LIMIT 1");
        return { status: "ok" };
      } catch (err) {
        return { status: "down", detail: String(err) };
      }
    });

    ctx.http((r) => {
      // Which buttons the login page should show.
      r.get("/providers", (_req, res) => {
        res.json({ github: github.isConfigured(config), google: google.isConfigured(config) });
      });

      // ---- GitHub ----
      r.get("/github/start", (req, res) => {
        if (!github.isConfigured(config)) return res.status(503).json({ error: "GitHub sign-in is not configured" });
        const state = beginSignIn(req, identity, "github");
        res.redirect(github.authorizeUrl(config, state, origin(req)));
      });

      // Called by the /auth/github/callback page with the code GitHub gave it.
      r.post("/github/callback", async (req, res) => {
        const { code, state } = req.body ?? {};
        if (!code || !state) return res.status(400).json({ error: "Missing code or state" });
        if (!(await consumeState(req, db, "github", state))) return res.status(403).json({ error: "Invalid OAuth state" });
        try {
          const profile = await github.profileFromCode(config, code);
          const user = await findOrLinkOrCreate(db, identity, { provider: "github", ...profile });
          await identity.signIn(req, user.id);
          res.json({ user: { id: user.id, username: user.username, email: user.email, isAdmin: user.isAdmin } });
        } catch (err) {
          logger.warn("GitHub sign-in failed", { error: err instanceof Error ? err.message : String(err) });
          const message = err instanceof LoginRefused ? err.message : "GitHub authentication failed";
          res.status(401).json({ error: message });
        }
      });

      // ---- Google ----
      r.get("/google/start", (req, res) => {
        if (!google.isConfigured(config)) return res.status(503).json({ error: "Google sign-in is not configured" });
        const state = beginSignIn(req, identity, "google");
        res.redirect(google.authorizeUrl(config, state, origin(req)));
      });

      // Google redirects the browser here directly.
      r.get("/google/callback", async (req, res) => {
        const { code, state, error } = req.query as Record<string, string | undefined>;
        const ok = await consumeState(req, db, "google", state);
        if (error || !code || !ok) return res.redirect("/login?error=oauth_failed");
        try {
          const profile = await google.profileFromCode(config, code, origin(req));
          const user = await findOrLinkOrCreate(db, identity, { provider: "google", ...profile });
          await identity.signIn(req, user.id);
          res.redirect("/console");
        } catch (err) {
          logger.warn("Google sign-in failed", { error: err instanceof Error ? err.message : String(err) });
          res.redirect("/login?error=oauth_failed");
        }
      });
    });
  },
};

export default plugin;
