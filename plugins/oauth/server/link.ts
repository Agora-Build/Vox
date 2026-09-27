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
    await db.query(
      "INSERT INTO identities (provider, subject, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [provider, subject, existing.id],
    );
    await identity.markEmailVerified(existing.id);
    return existing;
  }

  const created = await identity.createUser({ email, preferredUsername: account.preferredUsername });
  await db.query(
    "INSERT INTO identities (provider, subject, user_id) VALUES ($1, $2, $3)",
    [provider, subject, created.id],
  );
  return created;
}
