import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { PassThrough, Readable } from "stream";
import { artifactPreviewUrl, previewArtifact, registerArtifactPreviewRoutes, PREVIEW_GLOBAL_LIMIT, PREVIEW_USER_LIMIT, PREVIEW_OPEN_TIMEOUT, PREVIEW_IDLE_TIMEOUT, PREVIEW_TOTAL_TIMEOUT } from "../server/artifact-preview";
import { canViewJob } from "../server/permissions";
import type { AuthUser } from "../server/auth";
import type { EvalJob, EvalFlow } from "../shared/schema";

describe("job artifact preview streaming", () => {
  const name = "vox-RSP-chunk_001-179118416817-gbqkvs/recordings/recording.webm";
  const key = `jobs/35360/${name}`;
  let user: AuthUser | undefined;
  let job: EvalJob;
  let flow: EvalFlow | undefined;
  let files: unknown[];
  let app: express.Express;
  let close: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;
  const url = () => `/api/eval-jobs/35360/artifact-preview?name=${encodeURIComponent(name)}`;
  beforeEach(() => {
    user = { id: 7, isEnabled: true, isAdmin: false, membership: null } as AuthUser;
    job = { id: 35360, kind: "eval", createdBy: 7, evalFlowId: null } as EvalJob;
    flow = undefined;
    files = [{ name, url: key, size: 3, contentType: "audio/webm" }];
    close = vi.fn();
    open = vi.fn(async () => ({ body: Readable.from([Buffer.from("abc")]), contentLength: 3, close }));
    app = express();
    registerArtifactPreviewRoutes(app, { user: async () => user, job: async () => job, flow: async () => flow, results: async () => [{ artifactFiles: files }], canView: canViewJob, open });
  });
  afterEach(() => vi.useRealTimers());
  it("streams only the owner's listed object with private response headers", async () => {
    const result = await request(app).get(url()).buffer(true).parse((response, callback) => {
      const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => callback(null, Buffer.concat(chunks)));
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(Buffer.from("abc"));
    expect(result.headers["content-type"]).toMatch(/audio\/webm/);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(open).toHaveBeenCalledWith(7, key, expect.any(AbortSignal));
    expect(close).toHaveBeenCalled();
  });
  it("rejects unauthenticated viewers and another user's orphaned job before storage access", async () => {
    user = undefined;
    expect((await request(app).get(url())).status).toBe(401);
    user = { id: 8, isEnabled: true, isAdmin: false, membership: null } as AuthUser;
    expect((await request(app).get(url())).status).toBe(403);
    expect(open).not.toHaveBeenCalled();
  });
  it("respects live flow visibility and refuses Analyze jobs even for admins", async () => {
    user = { id: 8, isEnabled: true, isAdmin: false, membership: null } as AuthUser;
    job.evalFlowId = 1;
    flow = { ownerId: 7, visibility: "private" } as EvalFlow;
    expect((await request(app).get(url())).status).toBe(403);
    flow.visibility = "public";
    expect((await request(app).get(url())).status).toBe(200);
    job.kind = "analyze"; user.isAdmin = true;
    expect((await request(app).get(url())).status).toBe(404);
  });
  it("rejects a disabled user with an otherwise valid session before reading storage", async () => {
    user!.isEnabled = false;
    expect((await request(app).get(url())).status).toBe(401);
    expect(open).not.toHaveBeenCalled();
  });
  it("refuses unlisted names, traversal, arbitrary URLs and keys for other jobs", async () => {
    expect((await request(app).get("/api/eval-jobs/35360/artifact-preview?name=other.webm")).status).toBe(404);
    for (const urlValue of ["https://169.254.169.254/secret", "jobs/1/recording.webm", "jobs/35360/other.webm"]) {
      files = [{ name, url: urlValue }];
      expect((await request(app).get(url())).status).toBe(404);
    }
    expect(previewArtifact(35360, { name: "../secret.webm", url: "jobs/35360/../secret.webm" })).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });
  it("rejects invalid job IDs and repeated query values", async () => {
    expect((await request(app).get("/api/eval-jobs/35360x/artifact-preview?name=a.webm")).status).toBe(400);
    expect((await request(app).get("/api/eval-jobs/1e3/artifact-preview?name=a.webm")).status).toBe(400);
    expect((await request(app).get(url() + "&name=other.webm")).status).toBe(400);
    expect(open).not.toHaveBeenCalled();
  });
  it("caps declared length before streaming and always closes storage", async () => {
    open.mockResolvedValue({ body: Readable.from([Buffer.from("abc")]), contentLength: 64 * 1024 * 1024 + 1, close });
    expect((await request(app).get(url())).status).toBe(413);
    expect(close).toHaveBeenCalled();
  });
  it("provides preview links only for scoped audio and turns.json artifacts", () => {
    expect(artifactPreviewUrl(35360, files[0])).toBe(url());
    expect(previewArtifact(35360, { name: "analysis/turns.json", url: "jobs/35360/analysis/turns.json" })?.limit).toBe(5 * 1024 * 1024);
    expect(artifactPreviewUrl(35360, { name: "image.svg", url: "jobs/35360/image.svg" })).toBeUndefined();
    expect(artifactPreviewUrl(35360, { name: "metrics.json", url: "jobs/35360/metrics.json" })).toBeUndefined();
    for (const extension of ["constructor", "__proto__"]) {
      const name = `recording.${extension}`;
      expect(artifactPreviewUrl(35360, { name, url: `jobs/35360/${name}` })).toBeUndefined();
    }
    for (const extension of ["wav", "webm", "mp3", "mp4", "m4a", "aac", "ogg", "flac"]) {
      const name = `recording.${extension}`;
      expect(artifactPreviewUrl(35360, { name, url: `jobs/35360/${name}` })).toContain(encodeURIComponent(name));
    }
  });
  it("returns a generic upstream failure without exposing storage URLs or credentials", async () => {
    open.mockRejectedValue(new Error("secret-key at https://private-storage.example"));
    const result = await request(app).get(url());
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: "Artifact storage is unavailable" });
  });
  it("rejects invalid upstream metadata before sending an artifact response", async () => {
    for (const contentLength of [-1, Infinity, NaN, 1.5]) {
      open.mockResolvedValue({ body: Readable.from([Buffer.from("abc")]), contentLength, close });
      expect((await request(app).get(url())).status).toBe(502);
    }
    open.mockResolvedValue({ body: Readable.from([Buffer.from("abc")]), contentEncoding: "unknown", close });
    expect((await request(app).get(url())).status).toBe(502);
    expect(close).toHaveBeenCalledTimes(5);
  });
  it("caps actual streamed bytes without trusting missing or incorrect Content-Length", async () => {
    const transcript = "analysis/turns.json";
    files = [{ name: transcript, url: `jobs/35360/${transcript}` }];
    const body = Readable.from([Buffer.alloc(1024), Buffer.alloc(5 * 1024 * 1024)]);
    open.mockResolvedValue({ body, close: () => { close(); body.destroy(); } });
    await expect(request(app).get(`/api/eval-jobs/35360/artifact-preview?name=${encodeURIComponent(transcript)}`)).rejects.toThrow();
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(body.destroyed).toBe(true);
  });
  it("limits concurrent downloads per user and cancels storage when the viewer disconnects", async () => {
    const bodies: PassThrough[] = [];
    const signals: AbortSignal[] = [];
    open.mockImplementation(async (_id, _key, signal: AbortSignal) => {
      const body = new PassThrough(); bodies.push(body); signals.push(signal);
      return { body, close: () => body.destroy() };
    });
    const downloads = Array.from({ length: PREVIEW_USER_LIMIT }, () => request(app).get(url()));
    const pending = downloads.map((test) => test.then(() => {}, () => {}));
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(PREVIEW_USER_LIMIT));
    expect((await request(app).get(url())).status).toBe(429);
    downloads.forEach((download) => download.abort());
    await Promise.all(pending);
    await vi.waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
    expect(bodies.every((body) => body.destroyed)).toBe(true);
    open.mockResolvedValue({ body: Readable.from([Buffer.from("abc")]), contentLength: 3, close });
    expect((await request(app).get(url())).status).toBe(200);
  });
  it("limits all users together and releases aborted requests", async () => {
    const bodies: PassThrough[] = [];
    open.mockImplementation(async () => {
      const body = new PassThrough(); bodies.push(body);
      return { body, close: () => body.destroy() };
    });
    user!.isAdmin = true;
    const downloads: { abort(): unknown }[] = [];
    const pending: Promise<unknown>[] = [];
    for (let index = 0; index < PREVIEW_GLOBAL_LIMIT; index++) {
      user = { ...user!, id: index + 10 };
      const download = request(app).get(url());
      downloads.push(download);
      pending.push(download.then(() => {}, () => {}));
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(index + 1));
    }
    user = { ...user!, id: 99 };
    expect((await request(app).get(url())).status).toBe(429);
    downloads.forEach((download) => download.abort());
    await Promise.all(pending);
    await vi.waitFor(() => expect(bodies.every((body) => body.destroyed)).toBe(true));
    open.mockResolvedValue({ body: Readable.from([Buffer.from("abc")]), contentLength: 3, close });
    expect((await request(app).get(url())).status).toBe(200);
  });
  it("allows a steadily progressing stream to continue beyond the storage-open deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const body = new PassThrough();
    open.mockResolvedValue({ body, close: () => { close(); body.destroy(); } });
    const pending = request(app).get(url()).then((response) => response);
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    for (let index = 0; index < 3; index++) {
      body.write(Buffer.from("a"));
      await vi.advanceTimersByTimeAsync(20_000);
    }
    body.end(Buffer.from("b"));
    expect((await pending).status).toBe(200);
    expect(close).toHaveBeenCalledOnce();
  });
  it("aborts an idle stream and releases its storage resources", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const body = new PassThrough(); const signal: AbortSignal[] = [];
    open.mockImplementation(async (_id, _key, current: AbortSignal) => { signal.push(current); return { body, close: () => { close(); body.destroy(); } }; });
    const pending = request(app).get(url()).then(() => {}, () => {});
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(PREVIEW_IDLE_TIMEOUT + 1); await pending;
    expect(signal[0].aborted).toBe(true); expect(body.destroyed).toBe(true); expect(close).toHaveBeenCalledOnce();
  });
  it("keeps a finite total deadline even for a continuously progressing stream", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const body = new PassThrough();
    open.mockResolvedValue({ body, close: () => { close(); body.destroy(); } });
    const pending = request(app).get(url()).then(() => {}, () => {});
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    for (let elapsed = 0; elapsed < PREVIEW_TOTAL_TIMEOUT; elapsed += 20_000) {
      if (!body.destroyed) body.write(Buffer.from("a"));
      await vi.advanceTimersByTimeAsync(20_000);
    }
    await pending;
    expect(body.destroyed).toBe(true); expect(close).toHaveBeenCalledOnce();
  });
  it("bounds waiting for storage to open independently of stream progress", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    open.mockImplementation(async (_id, _key, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true })));
    const pending = request(app).get(url()).then((response) => response);
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(PREVIEW_OPEN_TIMEOUT + 1);
    expect((await pending).status).toBe(504);
    expect(close).not.toHaveBeenCalled();
  });
});
