/**
 * API v1 Routes for External Integration
 *
 * These routes provide a versioned API for external clients (CLI, mobile, etc.)
 * All routes require API key authentication via Bearer token.
 *
 * Authentication: Bearer vox_live_xxxxx
 */

import { Express, Request, Response } from "express";
import { storage } from "./storage";
import { requireAuthOrApiKey, getCurrentUserOrApiKeyUser } from "./auth";

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
      const { region, evalSetId, priority } = req.body;

      const workflow = await storage.getWorkflow(parseInt(id));

      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      // Check access: owner only can run
      if (workflow.ownerId !== user.id) {
        return res.status(403).json({ error: "Not authorized to run this workflow" });
      }

      // Create eval job
      const job = await storage.createEvalJob({
        workflowId: parseInt(id),
        evalSetId: evalSetId || null,
        region: region || "na",
        status: "pending",
        priority: priority || 0,
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

      // Validate status if provided
      const validStatuses = ["pending", "running", "completed", "failed"] as const;
      const statusFilter = status && validStatuses.includes(status as typeof validStatuses[number])
        ? (status as typeof validStatuses[number])
        : undefined;

      const jobs = await storage.getEvalJobs({
        ownerId: user.id,
        status: statusFilter,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });

      res.json({
        data: jobs,
        meta: {
          limit: limit ? parseInt(limit as string) : 50,
          offset: offset ? parseInt(offset as string) : 0,
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

      // Get workflow to check ownership
      const workflow = await storage.getWorkflow(job.workflowId);
      if (!workflow || workflow.ownerId !== user.id) {
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

      // Get workflow to check ownership
      const workflow = await storage.getWorkflow(job.workflowId);
      if (!workflow || workflow.ownerId !== user.id) {
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

      const workflow = await storage.getWorkflow(job.workflowId);
      if (!workflow || workflow.ownerId !== user.id) {
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
      const results = await storage.getMainlineEvalResults(50);

      // Transform to API format
      const metrics = results.map((r) => ({
        id: r.id,
        provider: r.providerId,
        region: r.region,
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
      const { region } = req.query;
      const results = await storage.getMainlineEvalResults(1000);

      // Aggregate by provider and region
      const providerRegionMap = new Map<string, {
        providerId: string;
        region: string;
        responseLatencies: number[];
        interruptLatencies: number[];
        networkResiliences: number[];
        naturalnesses: number[];
        noiseReductions: number[];
      }>();

      for (const result of results) {
        if (region && result.region !== region) continue;

        const key = `${result.providerId}-${result.region}`;
        if (!providerRegionMap.has(key)) {
          providerRegionMap.set(key, {
            providerId: result.providerId,
            region: result.region,
            responseLatencies: [],
            interruptLatencies: [],
            networkResiliences: [],
            naturalnesses: [],
            noiseReductions: [],
          });
        }

        const entry = providerRegionMap.get(key)!;
        entry.responseLatencies.push(result.responseLatencyMedian);
        entry.interruptLatencies.push(result.interruptLatencyMedian);
        if (result.networkResilience !== null) entry.networkResiliences.push(result.networkResilience);
        if (result.naturalness !== null) entry.naturalnesses.push(result.naturalness);
        if (result.noiseReduction !== null) entry.noiseReductions.push(result.noiseReduction);
      }

      // Calculate averages and build leaderboard
      const leaderboard = Array.from(providerRegionMap.values()).map((entry) => {
        const avg = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

        return {
          provider: entry.providerId,
          region: entry.region,
          responseLatency: avg(entry.responseLatencies),
          interruptLatency: avg(entry.interruptLatencies),
          networkResilience: avg(entry.networkResiliences),
          naturalness: entry.naturalnesses.length > 0
            ? Math.round((entry.naturalnesses.reduce((a, b) => a + b, 0) / entry.naturalnesses.length) * 10) / 10
            : 0,
          noiseReduction: avg(entry.noiseReductions),
        };
      });

      // Sort by weighted score (lower latency is better)
      leaderboard.sort((a, b) => a.responseLatency - b.responseLatency);

      // Add ranks
      const rankedLeaderboard = leaderboard.map((entry, index) => ({
        rank: index + 1,
        ...entry,
      }));

      res.json({
        data: rankedLeaderboard,
        meta: {
          timestamp: new Date().toISOString(),
          region: region || "all",
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
          isOrgAdmin: user.isOrgAdmin,
        },
      });
    } catch (error) {
      console.error("API v1 - Error fetching user:", error);
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });
}
