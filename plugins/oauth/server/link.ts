import type { IdentityService, IdentityUser, PluginDb } from "@vox/plugin-sdk";

export type Provider = "github" | "google";

/** A sign-in the user should see the reason for (disabled account, conflict). */
export class LoginRefused extends Error {}

export interface ExternalAccount {
  provider: Provider;
  subject: string;           // the provider's stable account id
  email: string;             // verified by the provider
  preferredUsername?: string;
}

/**
 * The account-linking rules, unchanged from when they lived in Core:
 *   1. an account already linked to this provider id → that user
 *   2. else a user with this email → link it (refused if that user is already
 *      linked to a DIFFERENT account on this provider — otherwise anyone who
 *      controls the email at the provider could take the account over)
 *   3. else → a new user
 * A disabled user is refused at every step.
 */
export async function findOrLinkOrCreate(
  db: PluginDb,
  identity: IdentityService,
  account: ExternalAccount,
): Promise<IdentityUser> {
  const { provider, subject, email } = account;

  const linked = await db.query<{ user_id: number }>(
    "SELECT user_id FROM identities WHERE provider = $1 AND subject = $2",
    [provider, subject],
  );
  if (linked.rows.length > 0) {
    const user = await identity.getUserById(linked.rows[0].user_id);
    if (user) {
      if (!user.isEnabled) throw new LoginRefused("Account is disabled");
      return user;
    }
    // The Core user is gone; drop the stale link and fall through.
    await db.query("DELETE FROM identities WHERE provider = $1 AND subject = $2", [provider, subject]);
  }

  const existing = await identity.getUserByEmail(email);
  if (existing) {
    const other = await db.query<{ subject: string }>(
      "SELECT subject FROM identities WHERE provider = $1 AND user_id = $2",
      [provider, existing.id],
    );
    if (other.rows.length > 0 && other.rows[0].subject !== subject) {
      throw new LoginRefused(`Email already linked to a different ${provider === "github" ? "GitHub" : "Google"} account`);
    }
    if (!existing.isEnabled) throw new LoginRefused("Account is disabled");
    // Pre-hijack guard: someone could register a password account under this
    // email before its owner ever arrives. Adopting it here would hand the
    // owner an account whose password the other party still holds. Only an
    // account whose email was never verified AND that has a password is
    // refused; its owner can still sign in with the password.
    if (!existing.emailVerified && existing.hasPassword) {
      throw new LoginRefused("An account with this email exists but its email is not verified. Sign in with your password.");
    }
    // The check above and this insert are not atomic: a concurrent sign-in may
    // link first. RETURNING tells us whether this insert won; if not, sign in
    // only if the winning row is this same user and account.
    const inserted = await db.query(
      "INSERT INTO identities (provider, subject, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING user_id",
      [provider, subject, existing.id],
    );
    if (inserted.rows.length === 0 && !(await isLinkedTo(db, provider, subject, existing.id))) {
      throw new LoginRefused("This sign-in conflicted with another one. Please try again.");
    }
    await identity.markEmailVerified(existing.id);
    return existing;
  }

  const created = await identity.createUser({ email, preferredUsername: account.preferredUsername });
  const inserted = await db.query(
    "INSERT INTO identities (provider, subject, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING user_id",
    [provider, subject, created.id],
  );
  if (inserted.rows.length === 0) {
    // A concurrent first sign-in for this same account linked first; the
    // account belongs to whoever it was linked to. (The user created above is
    // left unlinked; nothing refers to it.)
    const winner = await db.query<{ user_id: number }>(
      "SELECT user_id FROM identities WHERE provider = $1 AND subject = $2",
      [provider, subject],
    );
    const user = winner.rows[0] && (await identity.getUserById(winner.rows[0].user_id));
    if (!user) throw new LoginRefused("This sign-in conflicted with another one. Please try again.");
    return user;
  }
  return created;
}

async function isLinkedTo(db: PluginDb, provider: Provider, subject: string, userId: number): Promise<boolean> {
  const r = await db.query<{ user_id: number }>(
    "SELECT user_id FROM identities WHERE provider = $1 AND subject = $2",
    [provider, subject],
  );
  return r.rows[0]?.user_id === userId;
}
