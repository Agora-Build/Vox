import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { HttpHost } from "../server/plugins/hosts/http";

describe("HttpHost async error boundary", () => {
  it("turns a rejected async handler into a 500 instead of crashing the process", async () => {
    const host = new HttpHost();
    const r = host.createRegistrar("sample");
    r.get("/boom", async () => {
      throw new Error("boom");
    });
    r.get("/ok", (_req, res) => {
      res.json({ ok: true });
    });

    const app = express();
    host.mount(app);

    // Guard: if the handler's rejection escaped as an unhandled rejection, this
    // listener will catch it so the test fails loudly instead of the process dying.
    let unhandled: unknown = null;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const boomRes = await request(app).get("/api/plugins/sample/boom");
      expect(boomRes.status).toBe(500);
      expect(boomRes.body).toEqual({ error: "Internal plugin error" });

      // The process (and this Express app) must still be usable afterwards.
      const okRes = await request(app).get("/api/plugins/sample/ok");
      expect(okRes.status).toBe(200);
      expect(okRes.body).toEqual({ ok: true });

      // Give the microtask queue a tick to surface any stray unhandled rejection.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not double-send a response if headers were already sent before the rejection", async () => {
    const host = new HttpHost();
    const r = host.createRegistrar("sample2");
    r.get("/partial", async (_req, res) => {
      res.status(202).json({ started: true });
      throw new Error("post-response failure");
    });

    const app = express();
    host.mount(app);

    const res = await request(app).get("/api/plugins/sample2/partial");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true });
  });
});
