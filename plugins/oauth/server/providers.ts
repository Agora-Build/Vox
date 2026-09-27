import type { ConfigReader } from "@vox/plugin-sdk";

// Both providers use the authorization-code flow with the exchange done here on
// the server, so the client secret never reaches the browser.

export interface ProviderProfile {
  subject: string;
  email: string;
  preferredUsername?: string;
}

// A configured callback may be absolute (https://…) or a path; providers require
// an absolute redirect_uri.
function absolute(configured: string, origin: string): string {
  return configured.startsWith("http") ? configured : `${origin}${configured}`;
}

export interface GithubEmail { email: string; primary: boolean; verified: boolean }

/**
 * The email that decides which existing Vox account a GitHub sign-in links to,
 * so it must be one GitHub has verified: the primary if verified, else any
 * verified one, else none. The profile's public `email` field is deliberately
 * not used — it carries no verified flag.
 */
export function pickVerifiedGithubEmail(emails: GithubEmail[]): string | null {
  return emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
}

// ==================== GitHub ====================
// The registered callback is a web page (/auth/github/callback), which POSTs the
// code to this plugin — GitHub OAuth Apps allow one callback URL, and it is the
// page rather than an API path.

export const github = {
  isConfigured: (config: ConfigReader) => !!(config.get("GITHUB_CLIENT_ID") && config.get("GITHUB_CLIENT_SECRET")),

  authorizeUrl(config: ConfigReader, state: string, origin: string): string {
    const params = new URLSearchParams({
      client_id: config.require("GITHUB_CLIENT_ID"),
      redirect_uri: absolute(config.get("GITHUB_CALLBACK_URL") || "/auth/github/callback", origin),
      scope: "user:email",
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },

  async profileFromCode(config: ConfigReader, code: string): Promise<ProviderProfile> {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.require("GITHUB_CLIENT_ID"),
        client_secret: config.require("GITHUB_CLIENT_SECRET"),
        code,
      }),
    });
    const token = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
    if (token.error || !token.access_token) {
      throw new Error(token.error_description || token.error || "Failed to exchange GitHub code");
    }
    const auth = { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" };

    const userRes = await fetch("https://api.github.com/user", { headers: auth });
    if (!userRes.ok) throw new Error("Failed to fetch GitHub user profile");
    const user = (await userRes.json()) as { id: number; login: string };

    const emailsRes = await fetch("https://api.github.com/user/emails", { headers: auth });
    if (!emailsRes.ok) throw new Error("Failed to fetch GitHub email addresses");
    const email = pickVerifiedGithubEmail((await emailsRes.json()) as GithubEmail[]);
    if (!email) throw new Error("No verified email on this GitHub account");
    return { subject: String(user.id), email, preferredUsername: user.login };
  },
};

// ==================== Google ====================

export const google = {
  isConfigured: (config: ConfigReader) => !!(config.get("GOOGLE_CLIENT_ID") && config.get("GOOGLE_CLIENT_SECRET")),

  redirectUri(config: ConfigReader, origin: string): string {
    return absolute(config.get("GOOGLE_CALLBACK_URL") || "/api/plugins/oauth/google/callback", origin);
  },

  authorizeUrl(config: ConfigReader, state: string, origin: string): string {
    const params = new URLSearchParams({
      client_id: config.require("GOOGLE_CLIENT_ID"),
      redirect_uri: this.redirectUri(config, origin),
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },

  async profileFromCode(config: ConfigReader, code: string, origin: string): Promise<ProviderProfile> {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.require("GOOGLE_CLIENT_ID"),
        client_secret: config.require("GOOGLE_CLIENT_SECRET"),
        redirect_uri: this.redirectUri(config, origin),
        grant_type: "authorization_code",
      }),
    });
    const token = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!tokenRes.ok || !token.access_token) {
      throw new Error(token.error_description || token.error || "Failed to exchange Google code");
    }

    const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!infoRes.ok) throw new Error("Failed to fetch Google profile");
    const info = (await infoRes.json()) as { sub: string; email?: string; email_verified?: boolean };

    // The email decides which existing Vox account this links to, so it must be
    // one Google has verified.
    if (!info.email) throw new Error("No email found in Google profile");
    if (info.email_verified !== true) throw new Error("Google has not verified this email address");
    return { subject: info.sub, email: info.email, preferredUsername: info.email.split("@")[0] };
  },
};
