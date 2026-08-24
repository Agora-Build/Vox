/**
 * API v1 Routes for External Integration
 *
 * These routes provide a versioned API for external clients (CLI, mobile, etc.)
 * All routes require API key authentication via Bearer token.
 *
 * Authentication: Bearer vox_live_xxxxx
 */

import { Express, Request, Response } from "express";
import { storage, mergeEvalConfig, buildJobSnapshot } from "./storage";
import { requireAuthOrApiKey, getCurrentUserOrApiKeyUser } from "./auth";
import { parsePlatformSetup, sessionScopeForWorkflow, evaluateSessionRequirement, getBrokeredSecretNames, ensureSession } from "./auth-session";
import { regionSiteSequence } from "@shared/regions";
import { hasOrg, sameOrg } from "./permissions";

type ApiRegionLocation = Awaited<ReturnType<typeof storage.getAllRegionLocations>>[number];

function apiRegionMetadata(siteId: string, locations: ApiRegionLocation[]) {
  const location = [...locations]
    .sort((a, b) => b.baseId.length - a.baseId.length)
    .find((entry) => regionSiteSequence(siteId, entry.baseId) !== null);
  if (!location) return {
    regionLabel: siteId,
    regionBaseId: null,
    city: null,
    countryCode: null,
    countryName: null,
    macroRegionCode: null,
    macroRegionName: null,
  };
  const sequence = siteId.slice(location.baseId.length + 1);
  return {
    regionLabel: `${location.displayName} ${sequence.padStart(2, "0")}`,
    regionBaseId: location.baseId,
    city: location.city,
    countryCode: location.countryCode,
    countryName: location.countryName,
    macroRegionCode: location.macroRegionCode,
    macroRegionName: location.macroRegionName,
  };
}

function apiRegionScope(
  locations: ApiRegionLocation[],
  query: { siteId?: unknown; location?: unknown; country?: unknown; macroRegion?: unknown; regionScope?: unknown },
) {
  if (query.regionScope !== undefined) {
    if ([query.siteId, query.location, query.country, query.macroRegion].some((value) => value !== undefined && value !== "")) {
      return { error: "regionScope cannot be combined with other region filters" };
    }
    const rawScopes = Array.isArray(query.regionScope) ? query.regionScope : [query.regionScope];
    const scopes = rawScopes.flatMap((value) => typeof value === "string" ? value.split(",") : []);
    const baseIds = new Set<string>();
    for (const rawScope of scopes) {
      const [level, rawValue, extra] = rawScope.trim().split(":");
      if (extra !== undefined || !rawValue || !["macro", "country", "location"].includes(level)) {
        return { error: "regionScope entries must be macro:<code>, country:<code>, or location:<baseId>" };
      }
      const value = level === "country" ? rawValue.toUpperCase() : rawValue.toLowerCase();
      const matches = locations.filter((entry) =>
        level === "macro" ? entry.macroRegionCode === value
          : level === "country" ? entry.countryCode === value
          : entry.baseId === value
      );
      if (matches.length === 0) return { error: `Unknown regionScope: ${rawScope}` };
      for (const match of matches) baseIds.add(match.baseId);
    }
    return baseIds.size > 0 ? { scope: { baseIds: Array.from(baseIds).sort() } } : { error: "regionScope cannot be empty" };
  }
  const supplied = [
    ["siteId", query.siteId],
    ["location", query.location],
    ["country", query.country],
    ["macroRegion", query.macroRegion],
  ].filter(([, value]) => value !== undefined && value !== "");
  if (supplied.length > 1) return { error: "Use only one region filter: siteId, location, country, or macroRegion" };
  if (supplied.length === 0) return {};

  const [kind, rawValue] = supplied[0];
  if (typeof rawValue !== "string" || !rawValue.trim()) return { error: `${kind} must be a non-empty string` };
  const value = rawValue.trim();
  if (kind === "siteId") return { scope: { siteId: value } };
  if (kind === "location") {
    const match = locations.find((entry) => entry.baseId === value);
    return match ? { scope: { baseIds: [match.baseId] } } : { error: "Unknown region location" };
  }
  const normalized = kind === "country" ? value.toUpperCase() : value.toLowerCase();
  const baseIds = locations
    .filter((entry) => kind === "country"
      ? entry.countryCode === normalized
      : entry.macroRegionCode === normalized)
    .map((entry) => entry.baseId);
  return baseIds.length > 0 ? { scope: { baseIds } } : { error: `Unknown ${kind}` };
}

export function registerApiV1Routes(app: Express): void {
  // ==================== WORKFLOWS ====================

  /**
   * GET /api/v1/workflows
   * List workflows accessible to the authenticated user
   */
  app.get("/api/v1/workflows", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const workflows = await storage.getWorkflowsByOwner(user.id);
      res.json({
        data: workflows,
        meta: {
          total: workflows.length,
        },
      });
    } catch (error) {
      console.error("API v1 - Error fetching workflows:", error);
      res.status(500).json({ error: "Failed to fetch workflows" });
    }
  });

  /**
   * POST /api/v1/workflows
   * Create a new workflow
   */
  app.post("/api/v1/workflows", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { name, description, providerId, projectId, visibility, config } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }

      if (!providerId) {
        return res.status(400).json({ error: "Provider required" });
      }
      const provider = await storage.getProvider(providerId);
      if (!provider) {
        return res.status(404).json({ error: "Provider not found" });
      }

      // Check workflow limits
      const workflowCount = await storage.countWorkflowsByOwner(user.id);
      const maxWorkflows = user.plan === "basic" ? 50 : 200; // Total across all projects

      if (workflowCount >= maxWorkflows) {
        return res.status(403).json({
          error: `Maximum ${maxWorkflows} workflows allowed for ${user.plan} plan`,
        });
      }

      // Visibility check
      const workflowVisibility = visibility || "public";
      if (workflowVisibility === "private" && user.plan === "basic") {
        return res.status(403).json({
          error: "Private workflows require Premium plan or higher",
        });
      }

      const workflow = await storage.createWorkflow({
        name,
        description,
        providerId,
        projectId,
        ownerId: user.id,
        visibility: workflowVisibility,
        config: config || {},
      });

      res.status(201).json({ data: workflow });
    } catch (error) {
      console.error("API v1 - Error creating workflow:", error);
      res.status(500).json({ error: "Failed to create workflow" });
    }
  });

  /**
   * GET /api/v1/workflows/:id
   * Get a specific workflow
   */
  app.get("/api/v1/workflows/:id", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { id } = req.params;
      const workflow = await storage.getWorkflow(parseInt(id));

      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      // Check access: owner or public
      if (workflow.ownerId !== user.id && workflow.visibility !== "public") {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({ data: workflow });
    } catch (error) {
      console.error("API v1 - Error fetching workflow:", error);
      res.status(500).json({ error: "Failed to fetch workflow" });
    }
  });

  /**
   * PUT /api/v1/workflows/:id
   * Update a workflow
   */
  app.put("/api/v1/workflows/:id", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { id } = req.params;
      const workflow = await storage.getWorkflow(parseInt(id));

      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      if (workflow.ownerId !== user.id) {
        return res.status(403).json({ error: "Not authorized to update this workflow" });
      }

      const { name, description, visibility, config } = req.body;

      // Visibility check
      if (visibility === "private" && user.plan === "basic") {
        return res.status(403).json({
          error: "Private workflows require Premium plan or higher",
        });
      }

      const updated = await storage.updateWorkflow(parseInt(id), {
        name: name ?? workflow.name,
        description: description ?? workflow.description,
        visibility: visibility ?? workflow.visibility,
        config: config ?? workflow.config,
      });

      res.json({ data: updated });
    } catch (error) {
      console.error("API v1 - Error updating workflow:", error);
      res.status(500).json({ error: "Failed to update workflow" });
    }
  });

  /**
   * DELETE /api/v1/workflows/:id
   * Delete a workflow
   */
  app.delete("/api/v1/workflows/:id", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { id } = req.params;
      const workflow = await storage.getWorkflow(parseInt(id));

      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      if (workflow.ownerId !== user.id) {
        return res.status(403).json({ error: "Not authorized to delete this workflow" });
      }

      await storage.deleteWorkflow(parseInt(id));
      res.json({ success: true });
    } catch (error) {
      console.error("API v1 - Error deleting workflow:", error);
      res.status(500).json({ error: "Failed to delete workflow" });
    }
  });

  /**
   * POST /api/v1/workflows/:id/run
   * Run a workflow (create an eval job)
   */
  app.post("/api/v1/workflows/:id/run", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { id } = req.params;
      const { evalSetId, priority } = req.body;
      // Pooled targeting: region baseId + tier (spec §5), mirroring the console
      // run route's pooled validation exactly. v1 does not support targetTokenId
      // (precision) dispatch — it never has; only the pool contract is migrated.
      const region = req.body.region != null ? String(req.body.region) : null;
      const targetTier = req.body.targetTier != null ? String(req.body.targetTier) : null;

      const workflow = await storage.getWorkflow(parseInt(id));

      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      // Check access: owner only can run
      if (workflow.ownerId !== user.id) {
        return res.status(403).json({ error: "Not authorized to run this workflow" });
      }

      if (!evalSetId) {
        return res.status(400).json({ error: "Eval set required" });
      }
      const evalSet = await storage.getEvalSet(evalSetId);
      if (!evalSet) {
        return res.status(404).json({ error: "Eval set not found" });
      }

      if (!region || !targetTier) {
        return res.status(400).json({ error: "region and targetTier are required for pooled dispatch" });
      }
      if (targetTier === "shared") {
        return res.status(400).json({ error: "Pooled shared dispatch is not available" });
      }
      if (!["private", "team", "public"].includes(targetTier)) {
        return res.status(400).json({ error: "Invalid targetTier" });
      }
      if (targetTier === "team" && !hasOrg(user)) {
        return res.status(400).json({ error: "Join an organization to use team agents" });
      }
      const regionLoc = (await storage.getAllRegionLocations()).find((l) => l.baseId === region && l.isActive);
      if (!regionLoc) {
        return res.status(400).json({ error: "region must be an active region" });
      }

      // does this workflow need a Core-minted login session? This route
      // is owner-only (untargeted run on the caller's own workflow), so the
      // untargeted owner/team WHO-may-dispatch gate the console run route
      // applies is satisfied structurally — only the misconfigured-pair
      // rejection, the tier-composition guards (mirroring the console route),
      // and the immutable session stamp are needed here.
      const wfConfig = (workflow.config ?? {}) as Record<string, unknown>;
      const setupInfo = parsePlatformSetup(wfConfig.stepsPrefix as string | undefined);
      const scope = sessionScopeForWorkflow(workflow);
      const sessionReq = evaluateSessionRequirement(setupInfo, await getBrokeredSecretNames(scope));
      if (sessionReq.kind === "misconfigured") {
        return res.status(400).json({ error: sessionReq.reason });
      }
      const sessionNeed = sessionReq.kind === "need" ? sessionReq.need : null;
      // Session-injection composition (spec §5 + item 2 tightening): the serve
      // gate admits owner + team agents only, so a public-pool claim would take
      // the job and then be refused the session; and a team-pool claim on a
      // personal (non-org) workflow is a guaranteed-failure dispatch.
      if (sessionNeed && targetTier === "public") {
        return res.status(403).json({ error: "Credential-injected workflows can only use your own or team agent pools" });
      }
      if (sessionNeed && targetTier === "team" &&
          !(workflow.organizationId != null && sameOrg({ organizationId: user.organizationId }, { organizationId: workflow.organizationId }))) {
        return res.status(403).json({ error: "Credential-injected workflows can only use a team pool when the workflow belongs to your organization" });
      }

      // Create eval job (merge configs + capture the immutable snapshot, same as the
      // console run path — otherwise these jobs lose provenance/attribution/tiering).
      const provider = await storage.getProvider(workflow.providerId);

      const jobConfig = mergeEvalConfig(workflow.config, evalSet.config);
      delete (jobConfig as Record<string, unknown>).sessionInjection; // server-stamped only
      const baseSnapshot = buildJobSnapshot(workflow, evalSet, provider, user.plan);
      const snapshot = sessionNeed
        ? {
            ...baseSnapshot,
            sessionInjection: {
              platformId: sessionNeed.platformId,
              emailSecret: sessionNeed.emailSecret,
              passwordSecret: sessionNeed.passwordSecret,
            },
          }
        : baseSnapshot;
      if (sessionNeed) {
        (jobConfig as Record<string, unknown>).sessionInjection = { platformId: sessionNeed.platformId };
        void ensureSession(scope, sessionNeed);
      }

      const job = await storage.createEvalJob({
        workflowId: parseInt(id),
        triggerType: 2, // manual (API v1 run)
        evalSetId,
        createdBy: user.id,
        siteId: null,
        targetRegion: region,
        targetTier: targetTier as "private" | "team" | "public",
        config: jobConfig,
        snapshot,
        status: "pending",
        priority: priority || 0,
        retryCount: 0,
        maxRetries: 3,
      });

      res.status(201).json({
        data: {
          job,
          message: "Job created and queued for execution",
        },
      });
    } catch (error) {
      console.error("API v1 - Error running workflow:", error);
      res.status(500).json({ error: "Failed to run workflow" });
    }
  });

  // ==================== EVAL SETS ====================

  /**
   * GET /api/v1/eval-sets
   * List eval sets
   */
  app.get("/api/v1/eval-sets", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const evalSets = await storage.getEvalSetsByOwner(user.id);
      res.json({
        data: evalSets,
        meta: {
          total: evalSets.length,
        },
      });
    } catch (error) {
      console.error("API v1 - Error fetching eval sets:", error);
      res.status(500).json({ error: "Failed to fetch eval sets" });
    }
  });

  /**
   * POST /api/v1/eval-sets
   * Create a new eval set
   */
  app.post("/api/v1/eval-sets", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { name, description, visibility, config } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }

      const evalSetVisibility = visibility || "public";
      if (evalSetVisibility === "private" && user.plan === "basic") {
        return res.status(403).json({
          error: "Private eval sets require Premium plan or higher",
        });
      }

      const evalSet = await storage.createEvalSet({
        name,
        description,
        ownerId: user.id,
        visibility: evalSetVisibility,
        config: config || {},
      });

      res.status(201).json({ data: evalSet });
    } catch (error) {
      console.error("API v1 - Error creating eval set:", error);
      res.status(500).json({ error: "Failed to create eval set" });
    }
  });

  /**
   * GET /api/v1/eval-sets/:id
   * Get a specific eval set
   */
  app.get("/api/v1/eval-sets/:id", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { id } = req.params;
      const evalSet = await storage.getEvalSet(parseInt(id));

      if (!evalSet) {
        return res.status(404).json({ error: "Eval set not found" });
      }

      // Check access: owner or public
      if (evalSet.ownerId !== user.id && evalSet.visibility !== "public") {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({ data: evalSet });
    } catch (error) {
      console.error("API v1 - Error fetching eval set:", error);
      res.status(500).json({ error: "Failed to fetch eval set" });
    }
  });

  // ==================== JOBS ====================

  /**
   * GET /api/v1/jobs
   * List eval jobs for the authenticated user
   */
  app.get("/api/v1/jobs", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { status, limit, offset } = req.query;

      const pageLimit = Math.min(Math.max(parseInt(limit as string) || 50, 1), 200);
      const pageOffset = Math.max(parseInt(offset as string) || 0, 0);

      // Validate status if provided
      const validStatuses = ["pending", "running", "completed", "failed"] as const;
      const statusFilter = status && validStatuses.includes(status as typeof validStatuses[number])
        ? (status as typeof validStatuses[number])
        : undefined;

      // Count total (no limit/offset) and fetch page in parallel
      const [allJobs, pagedJobs] = await Promise.all([
        storage.getEvalJobs({ ownerId: user.id, status: statusFilter }),
        storage.getEvalJobs({ ownerId: user.id, status: statusFilter, limit: pageLimit, offset: pageOffset }),
      ]);

      res.json({
        data: pagedJobs,
        meta: {
          total: allJobs.length,
          limit: pageLimit,
          offset: pageOffset,
        },
      });
    } catch (error) {
      console.error("API v1 - Error fetching jobs:", error);
      res.status(500).json({ error: "Failed to fetch jobs" });
    }
  });

  /**
   * GET /api/v1/jobs/:id
   * Get a specific job status
   */
  app.get("/api/v1/jobs/:id", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { id } = req.params;
      const job = await storage.getEvalJob(parseInt(id));

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check ownership — live workflow owner, or the job's creator once it's deleted.
      const workflow = job.workflowId != null ? await storage.getWorkflow(job.workflowId) : undefined;
      const allowed = workflow ? workflow.ownerId === user.id : job.createdBy === user.id;
      if (!allowed) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({ data: job });
    } catch (error) {
      console.error("API v1 - Error fetching job:", error);
      res.status(500).json({ error: "Failed to fetch job" });
    }
  });

  /**
   * DELETE /api/v1/jobs/:id
   * Cancel a pending job
   */
  app.delete("/api/v1/jobs/:id", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { id } = req.params;
      const job = await storage.getEvalJob(parseInt(id));

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check ownership — live workflow owner, or the job's creator once it's deleted.
      const workflow = job.workflowId != null ? await storage.getWorkflow(job.workflowId) : undefined;
      const allowed = workflow ? workflow.ownerId === user.id : job.createdBy === user.id;
      if (!allowed) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (job.status !== "pending") {
        return res.status(400).json({
          error: "Only pending jobs can be cancelled",
          currentStatus: job.status,
        });
      }

      await storage.cancelEvalJob(parseInt(id));
      res.json({ success: true, message: "Job cancelled" });
    } catch (error) {
      console.error("API v1 - Error cancelling job:", error);
      res.status(500).json({ error: "Failed to cancel job" });
    }
  });

  // ==================== RESULTS ====================

  /**
   * GET /api/v1/results
   * List eval results for the authenticated user
   */
  app.get("/api/v1/results", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { workflowId, jobId, limit, offset } = req.query;

      const results = await storage.getEvalResults({
        ownerId: user.id,
        workflowId: workflowId ? parseInt(workflowId as string) : undefined,
        jobId: jobId ? parseInt(jobId as string) : undefined,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });

      res.json({
        data: results,
        meta: {
          limit: limit ? parseInt(limit as string) : 50,
          offset: offset ? parseInt(offset as string) : 0,
        },
      });
    } catch (error) {
      console.error("API v1 - Error fetching results:", error);
      res.status(500).json({ error: "Failed to fetch results" });
    }
  });

  /**
   * GET /api/v1/results/:id
   * Get a specific result
   */
  app.get("/api/v1/results/:id", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { id } = req.params;
      const result = await storage.getEvalResult(parseInt(id));

      if (!result) {
        return res.status(404).json({ error: "Result not found" });
      }

      // Get job and workflow to check ownership
      const job = await storage.getEvalJob(result.evalJobId);
      if (!job) {
        return res.status(404).json({ error: "Associated job not found" });
      }

      const workflow = job.workflowId != null ? await storage.getWorkflow(job.workflowId) : undefined;
      const allowed = workflow ? workflow.ownerId === user.id : job.createdBy === user.id;
      if (!allowed) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({ data: result });
    } catch (error) {
      console.error("API v1 - Error fetching result:", error);
      res.status(500).json({ error: "Failed to fetch result" });
    }
  });

  // ==================== PROJECTS ====================

  /**
   * GET /api/v1/projects
   * List projects for the authenticated user
   */
  app.get("/api/v1/projects", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const projects = await storage.getProjectsByOwner(user.id);

      // Add workflow counts
      const projectsWithCounts = await Promise.all(
        projects.map(async (project) => ({
          ...project,
          workflowCount: await storage.countWorkflowsByProject(project.id),
        }))
      );

      res.json({
        data: projectsWithCounts,
        meta: {
          total: projects.length,
        },
      });
    } catch (error) {
      console.error("API v1 - Error fetching projects:", error);
      res.status(500).json({ error: "Failed to fetch projects" });
    }
  });

  /**
   * POST /api/v1/projects
   * Create a new project
   */
  app.post("/api/v1/projects", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { name, description } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }

      // Check project limits
      const projectCount = await storage.countProjectsByOwner(user.id);
      const maxProjects = user.plan === "basic" ? 5 : 20;

      if (projectCount >= maxProjects) {
        return res.status(403).json({
          error: `Maximum ${maxProjects} projects allowed for ${user.plan} plan`,
        });
      }

      const project = await storage.createProject({
        name,
        description,
        ownerId: user.id,
        organizationId: user.organizationId,
      });

      res.status(201).json({ data: project });
    } catch (error) {
      console.error("API v1 - Error creating project:", error);
      res.status(500).json({ error: "Failed to create project" });
    }
  });

  // ==================== METRICS (PUBLIC) ====================

  /**
   * GET /api/v1/metrics/realtime
   * Get real-time metrics (public endpoint)
   */
  app.get("/api/v1/metrics/realtime", async (req: Request, res: Response) => {
    try {
      const locations = await storage.getAllRegionLocations();
      const regionScope = apiRegionScope(locations, req.query);
      if ("error" in regionScope) return res.status(400).json({ error: regionScope.error });
      if (regionScope.scope?.siteId && !(await storage.isAllocatedSite(regionScope.scope.siteId, false))) {
        return res.status(400).json({ error: "siteId must be an exact allocated site ID" });
      }
      const results = await storage.getMainlineEvalResults(50, undefined, regionScope.scope);

      // Transform to API format
      const metrics = results.map((r) => ({
        id: r.id,
        provider: r.providerId,
        siteId: r.siteId,
        ...apiRegionMetadata(r.siteId, locations),
        responseLatency: r.responseLatencyMedian,
        interruptLatency: r.interruptLatencyMedian,
        networkResilience: r.networkResilience,
        naturalness: r.naturalness,
        noiseReduction: r.noiseReduction,
        timestamp: r.createdAt,
      }));

      res.json({
        data: metrics,
        meta: {
          timestamp: new Date().toISOString(),
          count: metrics.length,
        },
      });
    } catch (error) {
      console.error("API v1 - Error fetching realtime metrics:", error);
      res.status(500).json({ error: "Failed to fetch realtime metrics" });
    }
  });

  /**
   * GET /api/v1/metrics/leaderboard
   * Get leaderboard data (public endpoint)
   */
  app.get("/api/v1/metrics/leaderboard", async (req: Request, res: Response) => {
    try {
      const { siteId, location, country, macroRegion, regionScope: requestedScopes } = req.query;
      const locations = await storage.getAllRegionLocations();
      const regionScope = apiRegionScope(locations, { siteId, location, country, macroRegion, regionScope: requestedScopes });
      if ("error" in regionScope) return res.status(400).json({ error: regionScope.error });
      if (regionScope.scope?.siteId && !(await storage.isAllocatedSite(regionScope.scope.siteId, false))) {
        return res.status(400).json({ error: "siteId must be an exact allocated site ID" });
      }
      const results = await storage.getMainlineEvalResults(1000, undefined, regionScope.scope);

      // Aggregate by provider and site
      const providerRegionMap = new Map<string, {
        providerId: string;
        siteId: string;
        responseLatencies: number[];
        interruptLatencies: number[];
        turnSuccessRates: number[];
        networkResiliences: number[];
        naturalnesses: number[];
        noiseReductions: number[];
      }>();

      for (const result of results) {
        const key = `${result.providerId}-${result.siteId}`;
        if (!providerRegionMap.has(key)) {
          providerRegionMap.set(key, {
            providerId: result.providerId,
            siteId: result.siteId,
            responseLatencies: [],
            interruptLatencies: [],
            turnSuccessRates: [],
            networkResiliences: [],
            naturalnesses: [],
            noiseReductions: [],
          });
        }

        const entry = providerRegionMap.get(key)!;
        // Exclude NA (null) latencies — a non-responsive run must not average in
        // as a fake-fast 0 ms.
        if (result.responseLatencyMedian != null) entry.responseLatencies.push(result.responseLatencyMedian);
        if (result.interruptLatencyMedian != null) entry.interruptLatencies.push(result.interruptLatencyMedian);
        // TSR includes no-response runs as failed turns (resilience signal).
        if (result.turnSuccessRate != null) entry.turnSuccessRates.push(result.turnSuccessRate);
        if (result.networkResilience !== null) entry.networkResiliences.push(result.networkResilience);
        if (result.naturalness !== null) entry.naturalnesses.push(result.naturalness);
        if (result.noiseReduction !== null) entry.noiseReductions.push(result.noiseReduction);
      }

      // Calculate averages and build leaderboard. Latency avg is null (NA) for an
      // empty set (all runs non-responsive) — never 0.
      const leaderboard = Array.from(providerRegionMap.values()).map((entry) => {
        const avg = (arr: number[]): number | null => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

        const avgRate = (arr: number[]): number | null => arr.length > 0 ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10000) / 10000 : null;
        return {
          provider: entry.providerId,
          siteId: entry.siteId,
          ...apiRegionMetadata(entry.siteId, locations),
          responseLatency: avg(entry.responseLatencies),
          interruptLatency: avg(entry.interruptLatencies),
          turnSuccessRate: avgRate(entry.turnSuccessRates),
          networkResilience: avg(entry.networkResiliences),
          naturalness: entry.naturalnesses.length > 0
            ? Math.round((entry.naturalnesses.reduce((a, b) => a + b, 0) / entry.naturalnesses.length) * 10) / 10
            : null,
          noiseReduction: avg(entry.noiseReductions),
        };
      });

      // Sort by response latency (lower is better); NA (null) sinks to the bottom.
      leaderboard.sort((a, b) => {
        if (a.responseLatency == null) return b.responseLatency == null ? 0 : 1;
        if (b.responseLatency == null) return -1;
        return a.responseLatency - b.responseLatency;
      });

      // Add ranks
      const rankedLeaderboard = leaderboard.map((entry, index) => ({
        rank: index + 1,
        ...entry,
      }));

      res.json({
        data: rankedLeaderboard,
        meta: {
          timestamp: new Date().toISOString(),
          siteId: siteId || "all",
          location: location || "all",
          country: country || "all",
          macroRegion: macroRegion || "all",
          regionScope: requestedScopes || "all",
          count: rankedLeaderboard.length,
        },
      });
    } catch (error) {
      console.error("API v1 - Error fetching leaderboard:", error);
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });

  // ==================== PROVIDERS (PUBLIC) ====================

  /**
   * GET /api/v1/providers
   * List all providers (public endpoint)
   */
  app.get("/api/v1/providers", async (req: Request, res: Response) => {
    try {
      const providers = await storage.getAllProviders();
      res.json({
        data: providers,
        meta: {
          total: providers.length,
        },
      });
    } catch (error) {
      console.error("API v1 - Error fetching providers:", error);
      res.status(500).json({ error: "Failed to fetch providers" });
    }
  });

  // ==================== USER INFO ====================

  /**
   * GET /api/v1/user
   * Get current user info (useful for API key validation)
   */
  app.get("/api/v1/user", requireAuthOrApiKey, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUserOrApiKeyUser(req);
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      res.json({
        data: {
          id: user.id,
          username: user.username,
          email: user.email,
          plan: user.plan,
          organizationId: user.organizationId,
          orgRole: user.orgRole,
        },
      });
    } catch (error) {
      console.error("API v1 - Error fetching user:", error);
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });
}
