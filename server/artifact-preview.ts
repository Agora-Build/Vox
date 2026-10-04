import type { Express, Request } from "express";
import { Transform, type Readable } from "stream";
import { pipeline } from "stream/promises";
import type { EvalJob, EvalFlow, EvalResult } from "@shared/schema";
import type { AuthUser } from "./auth";

const AUDIO_LIMIT = 64 * 1024 * 1024;
const TRANSCRIPT_LIMIT = 5 * 1024 * 1024;

export interface ArtifactObject {
  body: Readable;
  contentLength?: number;
  contentEncoding?: string;
  close(): void;
}

interface PreviewServices {
  user(req: Request): Promise<AuthUser | undefined>;
  job(id: number): Promise<EvalJob | undefined>;
  flow(id: number): Promise<EvalFlow | undefined>;
  results(id: number): Promise<Pick<EvalResult, "artifactFiles">[]>;
  canView(user: AuthUser, job: EvalJob, flow?: EvalFlow): boolean;
  open(ownerId: number, key: string, signal: AbortSignal): Promise<ArtifactObject>;
}

export function previewArtifact(jobId: number, file: unknown) {
  if (!file || typeof file !== "object") return undefined;
  const { name, url } = file as Record<string, unknown>;
  if (typeof name !== "string" || name.length > 512 || name.includes("\\") || Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || name.split("/").some((part) => !part || part === "." || part === "..")
    || url !== `jobs/${jobId}/${name}`) return undefined;
  const audioTypes: Record<string, string> = { wav: "audio/wav", webm: "audio/webm", mp3: "audio/mpeg", mp4: "audio/mp4", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac" };
  const extension = name.split(".").pop()!.toLowerCase();
  const audioType = Object.hasOwn(audioTypes, extension) ? audioTypes[extension] : undefined;
  const transcript = /(?:^|\/)turns\.json$/i.test(name);
  if (!audioType && !transcript) return undefined;
  return { name, key: url as string, limit: transcript ? TRANSCRIPT_LIMIT : AUDIO_LIMIT, contentType: transcript ? "application/json" : audioType };
}

export function artifactPreviewUrl(jobId: number, file: unknown) {
  const artifact = previewArtifact(jobId, file);
  return artifact ? `/api/eval-jobs/${jobId}/artifact-preview?name=${encodeURIComponent(artifact.name)}` : undefined;
}

export function registerArtifactPreviewRoutes(app: Express, services: PreviewServices) {
  let active = 0;
  const byUser = new Map<number, number>();
  app.get("/api/eval-jobs/:id/artifact-preview", async (req, res) => {
    let object: ArtifactObject | undefined;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    const closed = () => controller.abort();
    res.on("close", closed);
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const user = await services.user(req);
      if (!user || !user.isEnabled) return void res.status(401).json({ error: "Not authenticated" });
      const jobId = Number(req.params.id);
      const name = req.query.name;
      if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(jobId) || typeof name !== "string") return void res.status(400).json({ error: "Invalid artifact request" });
      const job = await services.job(jobId);
      if (!job || job.kind === "analyze") return void res.status(404).json({ error: "Job not found" });
      const flow = job.evalFlowId != null ? await services.flow(job.evalFlowId) : undefined;
      if (!services.canView(user, job, flow)) return void res.status(403).json({ error: "Not authorized to view this job" });
      const results = await services.results(jobId);
      const files = results[0]?.artifactFiles;
      const file = Array.isArray(files) ? files.find((file) => file && typeof file === "object" && (file as Record<string, unknown>).name === name) : undefined;
      const artifact = previewArtifact(jobId, file);
      if (!artifact) return void res.status(404).json({ error: "Preview artifact not found" });
      const count = byUser.get(user.id) ?? 0;
      if (active >= 4 || count >= 2) { res.set("Retry-After", "3"); return void res.status(429).json({ error: "Too many artifact previews" }); }
      active++; byUser.set(user.id, count + 1);
      release = () => { active--; const remaining = (byUser.get(user.id) ?? 1) - 1; if (remaining) byUser.set(user.id, remaining); else byUser.delete(user.id); };
      if (controller.signal.aborted) throw new Error("Preview aborted");
      object = await services.open(job.createdBy ?? user.id, artifact.key, controller.signal);
      if (object.contentLength != null && (!Number.isSafeInteger(object.contentLength) || object.contentLength < 0)) throw new Error("Invalid storage length");
      if (object.contentEncoding && !["identity", "gzip", "deflate", "br"].includes(object.contentEncoding)) throw new Error("Unsupported storage encoding");
      if (object.contentLength != null && object.contentLength > artifact.limit) return void res.status(413).json({ error: "Preview artifact too large" });
      if (controller.signal.aborted) throw new Error("Preview aborted");
      res.set({ "Content-Type": artifact.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      if (object.contentLength != null) res.set("Content-Length", String(object.contentLength));
      if (object.contentEncoding && ["gzip", "deflate", "br"].includes(object.contentEncoding)) res.set("Content-Encoding", object.contentEncoding);
      let downloaded = 0;
      const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.length;
        callback(downloaded > artifact.limit ? new Error("Preview artifact too large") : null, downloaded > artifact.limit ? undefined : chunk);
      } });
      await pipeline(object.body, bounded, res, { signal: controller.signal });
    } catch {
      if (!res.headersSent && !res.destroyed) res.status(controller.signal.aborted ? 504 : 502).json({ error: "Artifact storage is unavailable" });
      else res.destroy();
    } finally {
      clearTimeout(timer); res.off("close", closed); controller.abort();
      object?.close(); release?.();
    }
  });
}
