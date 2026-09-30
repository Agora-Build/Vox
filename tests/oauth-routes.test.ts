import { describe, it, expect } from "vitest";

// The oauth plugin's routes on the running dev server (dev-local-run.sh loads
// the plugin and has GitHub + Google credentials). Everything here stops short
// of calling GitHub or Google, so it needs no network and cannot flake on it.

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "admin@vox.local";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123456";

const cookieOf = (res: Response) => (res.headers.get("set-cookie") || "").split(";")[0];

async function start(provider: "github" | "google", cookie = "") {
  const res = await fetch(`${BASE_URL}/api/plugins/oauth/${provider}/start`, {
    redirect: "manual",
    headers: cookie ? { Cookie: cookie } : {},
  });
  // Wait for the whole response, as a browser does before following the
  // redirect: express-session finishes saving the session (and the state in
  // it) as the response ends, so a callback sent on the headers alone can
  // arrive before the state exists.
  await res.text();
  const location = new URL(res.headers.get("location") || "http://invalid/");
  return { res, location, state: location.searchParams.get("state"), cookie: cookieOf(res) || cookie };
}

const githubCallback = (cookie: string, body: object) =>
  fetch(`${BASE_URL}/api/plugins/oauth/github/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });

describe("oauth plugin routes", () => {
  it("reports both providers on, since dev has credentials for both", async () => {
    const res = await fetch(`${BASE_URL}/api/plugins/oauth/providers`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ github: true, google: true });
  });

  it("GitHub start redirects to GitHub with a state token and the callback page", async () => {
    const { res, location, state } = await start("github");
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(state).toMatch(/^[0-9a-f]{48}$/);
    expect(location.searchParams.get("redirect_uri")).toMatch(/\/auth\/github\/callback$/);
    expect(location.searchParams.get("client_id")).toBeTruthy();
  });

  it("Google start redirects to Google with a state token and the plugin's callback", async () => {
    const { res, location, state } = await start("google");
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(state).toMatch(/^[0-9a-f]{48}$/);
    expect(location.searchParams.get("redirect_uri")).toMatch(/\/api\/plugins\/oauth\/google\/callback$/);
    expect(location.searchParams.get("scope")).toBe("openid email profile");
  });

  it("rejects a GitHub callback with no code or state", async () => {
    const res = await githubCallback("", {});
    expect(res.status).toBe(400);
  });

  it("rejects a forged state, and a state is single-use", async () => {
    const { cookie, state } = await start("github");
    const forged = await githubCallback(cookie, { code: "x", state: "0".repeat(48) });
    expect(forged.status).toBe(403);
    // The failed attempt consumed the real state too: replaying it is refused.
    const replay = await githubCallback(cookie, { code: "x", state });
    expect(replay.status).toBe(403);
  });

  // Review of #210: two callbacks with the same state that load the session at
  // the same moment both used to pass (200 of 200 concurrent pairs). The state
  // is now claimed atomically in plugin_oauth.used_states.
  it("a state is single-use even for two callbacks sent at the same moment", async () => {
    const outcomes = await Promise.all(Array.from({ length: 20 }, async () => {
      const { cookie, state } = await start("github");
      const bodies = await Promise.all([1, 2].map(async () => {
        const r = await githubCallback(cookie, { code: "x", state });
        return r.text();
      }));
      // Counted by the state refusal itself, not by status: the one that gets
      // past the state goes on to exchange the fake code with GitHub, and what
      // GitHub answers (usually 401 here) is not this test's business.
      return bodies.filter((b) => b.includes("Invalid OAuth state")).length;
    }));
    expect(outcomes).toEqual(Array(20).fill(1)); // exactly one of each pair is refused on the state
  });

  it("a state from one provider is not accepted by the other", async () => {
    const { cookie, state } = await start("google");
    const res = await githubCallback(cookie, { code: "x", state });
    expect(res.status).toBe(403);
  });

  it("a Google callback with a bad state is sent back to the login page", async () => {
    const { cookie } = await start("google");
    const res = await fetch(`${BASE_URL}/api/plugins/oauth/google/callback?code=x&state=${"0".repeat(48)}`, {
      redirect: "manual",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=oauth_failed");
  });

  it("starting a sign-in signs out whoever was signed in on that session", async () => {
    const login = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(login.ok).toBe(true);
    const cookie = cookieOf(login);
    const before = await (await fetch(`${BASE_URL}/api/auth/status`, { headers: { Cookie: cookie } })).json();
    expect(before.user?.email).toBe(ADMIN_EMAIL);

    await start("github", cookie);
    const after = await (await fetch(`${BASE_URL}/api/auth/status`, { headers: { Cookie: cookie } })).json();
    expect(after.user).toBeNull();
  });

  it("the old Core OAuth endpoints are gone", async () => {
    for (const path of ["/api/auth/github/status", "/api/auth/google/status"]) {
      const res = await fetch(`${BASE_URL}${path}`);
      // Unknown /api paths fall through to the app shell, never to JSON status.
      const body = await res.text();
      expect(body).not.toMatch(/"enabled"/);
    }
  });
});
