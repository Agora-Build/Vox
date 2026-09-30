import { describe, it, expect } from "vitest";

// #212: unknown /api routes used to fall through to the web app's index.html
// with a 200 — any method — so an API client with a typo (or on a moved path,
// like the pre-#211 provider writes) was told it succeeded.
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const hasDb = !!process.env.DATABASE_URL;

(hasDb ? describe : describe.skip)("unknown /api routes", () => {
  for (const [method, path] of [
    ["GET", "/api/does-not-exist"],
    ["POST", "/api/does-not-exist"],
    ["PATCH", "/api/providers/some-id"], // moved to /api/admin/providers in #211
    ["DELETE", "/api/v1/nope"],
  ] as const) {
    it(`${method} ${path} is a JSON 404`, async () => {
      const res = await fetch(`${BASE_URL}${path}`, { method });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(await res.json()).toEqual({ error: "Not found" });
    });
  }

  it("real API routes and the web app are unaffected", async () => {
    expect((await fetch(`${BASE_URL}/api/providers`)).status).toBe(200);
    const page = await fetch(`${BASE_URL}/console/eval-flows`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
  });
});
