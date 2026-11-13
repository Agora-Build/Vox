import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { getCurrentUser, requireAuth } from "./auth";
import { storage } from "./storage";
import { browserAgents, hasBrowserAssistance } from "./browser-agent-bridge";
import { browserViewers, type BrowserGrant } from "./browser-viewers";
import { requestBrowserCapture } from "./browser-captures";
import { BrowserAccessError, canAccessJobBrowser, resolveBrowserTarget as resolveTarget, sendBrowserTarget as sendTarget } from "./browser-target";
import { jobMayUseCredentials } from "./credential-trials";
import { canCancelJob } from "./permissions";
import { settleEndedJobsNow } from "./settle-now";
import { browserCommandSchema, type BrowserResponse, type BrowserStatus } from "@shared/browser-assistance";
import type { EvalJob } from "@shared/schema";

export { canAccessJobBrowser } from "./browser-target";
function closeGrant(grant: BrowserGrant): void {
  void requestBrowserCapture(grant, "leave").catch(() => undefined);
}
async function releaseGrant(id: string): Promise<void> {
  const grant = await browserViewers.remove(id);
  if (grant) closeGrant(grant);
}
let cleaning = false;
const cleanup = setInterval(() => {
  if (cleaning) return;
  cleaning = true;
  void browserViewers.expire().then((expired) => { for (const grant of expired) closeGrant(grant); })
    .catch(() => undefined).finally(() => { cleaning = false; });
}, 1000);
cleanup.unref();

async function authorizedJob(req: Request): Promise<{ job: EvalJob; userId: number }> {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new BrowserAccessError(400, "Invalid job ID");
  const user = await getCurrentUser(req);
  if (!user || !user.isEnabled) throw new BrowserAccessError(401, "Authentication required");
  const job = await storage.getEvalJob(id);
  if (!job) throw new BrowserAccessError(404, "Job not found");
  if (!canAccessJobBrowser(user, job)) throw new BrowserAccessError(403, "Browser access requires the personal flow and credential owner who launched this job, or an owner/admin of its organization");
  if (job.kind !== "eval" || job.transport !== "web" || !["pending", "running"].includes(job.status)) throw new BrowserAccessError(410, "No live browser for this job");
  if (!await jobMayUseCredentials(job)) throw new BrowserAccessError(403, "This job's credential authorization is no longer active");
  return { job, userId: user.id };
}

function reportError(res: Response, error: unknown): void {
  if (error instanceof BrowserAccessError) res.status(error.status).json({ error: error.message });
  else res.status(503).json({ error: "Browser connection unavailable. If an action was pending, inspect its outcome before acting again." });
}

export function registerBrowserAssistanceRoutes(app: Express): void {
  app.use("/api/eval-jobs/:id/browser", requireAuth, (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const origin = req.get("origin");
    if (origin) {
      try {
        const parsed = new URL(origin);
        // Browser-set Fetch Metadata preserves HTTPS same-origin proof across TLS-terminating proxy hops.
        const browserSameOrigin = req.get("sec-fetch-site") === "same-origin"
          && parsed.protocol === "https:" && parsed.host === req.get("host");
        if (parsed.origin !== `${req.protocol}://${req.get("host")}` && !browserSameOrigin) return res.status(403).json({ error: "Cross-origin browser access is forbidden" });
      }
      catch { return res.status(403).json({ error: "Invalid origin" }); }
    }
    next();
  });

  app.get("/api/eval-jobs/:id/browser", async (req, res) => {
    try {
      const { job } = await authorizedJob(req);
      const target = await resolveTarget(job);
      if (!target) return res.json({ available: false });
      const result = await sendTarget(target, { action: "status", viewerId: randomUUID() }) as BrowserResponse;
      if (!result?.ok) return res.json({ available: false });
      const { job: currentJob } = await authorizedJob(req);
      if ((await resolveTarget(currentJob))?.key !== target.key) throw new BrowserAccessError(410, "Browser execution changed; refresh before opening");
      res.json({ available: true, target: target.kind, deadline: target.kind === "broker" ? target.deadline : undefined, status: result.result as BrowserStatus });
    } catch (error) { reportError(res, error); }
  });

  app.post("/api/eval-jobs/:id/browser/viewers", async (req, res) => {
    try {
      const { job, userId } = await authorizedJob(req);
      const target = await resolveTarget(job);
      if (!target) throw new BrowserAccessError(503, "Browser assistance is unavailable on this runner");
      const viewerId = randomUUID();
      if (!await browserViewers.create({ id: viewerId, userId, jobId: job.id, target })) throw new BrowserAccessError(409, "Browser viewer limit reached; try again after another view closes");
      res.json({ viewerId });
    } catch (error) { reportError(res, error); }
  });

  const withGrant = async (req: Request, checkAuthority = true) => {
    const id = req.params.viewerId;
    const grant = await browserViewers.get(id);
    const userId = req.session?.userId;
    if (!grant || grant.userId !== userId || grant.jobId !== Number(req.params.id)) throw new BrowserAccessError(410, "Viewer grant expired");
    if (!checkAuthority) return { grant, id };
    try {
      const { job } = await authorizedJob(req);
      const current = await resolveTarget(job);
      if (!current || current.key !== grant.target.key) throw new BrowserAccessError(410, "Browser execution changed; reopen the viewer");
      return { grant, id };
    } catch (error) { await releaseGrant(id); throw error; }
  };

  app.post("/api/eval-jobs/:id/browser/viewers/:viewerId/commands", async (req, res) => {
    try {
      const { grant } = await withGrant(req);
      const parsed = browserCommandSchema.safeParse(req.body);
      if (!parsed.success) throw new BrowserAccessError(400, "Invalid browser command");
      // The UI's explicit action is still authorized here against current scope.
      const result = await requestBrowserCapture(grant, "command", parsed.data);
      await withGrant(req);
      if (!await browserViewers.touch(grant)) throw new BrowserAccessError(410, "Viewer expired; reopen the viewer");
      res.json(result);
    } catch (error) { reportError(res, error); }
  });

  app.get("/api/eval-jobs/:id/browser/viewers/:viewerId/frame", async (req, res) => {
    try {
      const { grant } = await withGrant(req, false);
      let frame;
      try { frame = await requestBrowserCapture(grant, "frame"); }
      catch (error) {
        if (!await browserViewers.get(grant.id)) throw new BrowserAccessError(410, "Viewer expired or authorization changed; reopen the view");
        throw error;
      }
      // The owner checks fresh authority before returning cached pixels and again after a slow capture.
      if (!await browserViewers.get(grant.id)) throw new BrowserAccessError(410, "Viewer grant expired");
      if (!frame) return res.status(204).end();
      res.json(frame);
    } catch (error) { reportError(res, error); }
  });

  app.delete("/api/eval-jobs/:id/browser/viewers/:viewerId", async (req, res) => {
    try {
      const grant = await browserViewers.remove(req.params.viewerId, req.session!.userId, Number(req.params.id));
      if (!grant) return res.status(404).json({ error: "Viewer not found" });
      closeGrant(grant); res.json({ closed: true });
    } catch (error) { reportError(res, error); }
  });

  app.post("/api/eval-jobs/:id/browser/cancel-job", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new BrowserAccessError(400, "Invalid job ID");
      const user = await getCurrentUser(req);
      const job = await storage.getEvalJob(id);
      if (!user || !job) throw new BrowserAccessError(404, "Job not found");
      if (!user.isEnabled) throw new BrowserAccessError(401, "Account is disabled");
      const flow = job.evalFlowId ? await storage.getEvalFlow(job.evalFlowId) : undefined;
      if (!canCancelJob(user, job, flow)) throw new BrowserAccessError(403, "Not authorized to cancel this job");
      if (job.kind !== "eval" || job.transport !== "web" || job.status !== "running" || !job.startedAt || !job.evalAgentId) throw new BrowserAccessError(409, "Job is no longer running");
      if (job.snapshot?.settlementContext !== undefined) throw new BrowserAccessError(409, "Active cancellation is unavailable for paid marketplace jobs; pending jobs can still be cancelled");
      const agent = await storage.getEvalAgent(job.evalAgentId);
      if (!agent?.currentLeaseId || !hasBrowserAssistance(agent.metadata)) throw new BrowserAccessError(409, "This agent does not support active cancellation");
      const cancelled = await storage.cancelRunningEvalJob(job.id, user.id, job.startedAt);
      if (!cancelled) throw new BrowserAccessError(409, "Job completed or changed before cancellation");
      for (const grant of await browserViewers.removeJob(job.id)) closeGrant(grant);
      const acknowledged = await browserAgents.request(agent.id, agent.currentLeaseId,
        { jobId: job.id, startedAt: job.startedAt.toISOString() }, { action: "cancel" })
        .then((result) => !!result && typeof result === "object" && "cancelled" in result && result.cancelled === true, () => false);
      await settleEndedJobsNow([cancelled], "cancelled");
      res.json({ cancelled: true, cancellationDelivery: acknowledged ? "acknowledged" : "pending" });
    } catch (error) { reportError(res, error); }
  });
}
