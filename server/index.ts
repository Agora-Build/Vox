import express, { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import { authenticateApiKey, passport, initializeGoogleOAuth } from "./auth";
import { storage, mergeEvalConfig, buildJobSnapshot, pool } from "./storage";
import { canScheduleWorkflow, sessionPoolViolation } from "./permissions";
import { parseNextCronRun } from "./cron";
import { setupClashWebSocket } from "./clash-ws";
import { loadPlugins } from "./plugins/loader";
import { setMarketplace, getMarketplace, type EvalMarketplace } from "./marketplace";
import { stampOwnerSession, detectSessionNeed, missingSecretNames, sessionScopeForWorkflow } from "./auth-session";
import pkg from "pg";
const { Pool } = pkg;

// Global hard cap on how long a single eval job may stay "running" before the
// background reaper fails it (agent zombied/superseded/killed). Tune here.
const MAX_JOB_RUN_MINUTES = 90;

// A "pending" job is one no agent has claimed yet. Two reapers keep it from
// hanging forever (nothing else touches the pending state):
//   - PENDING_NO_AGENT_TIMEOUT_MINUTES: fast-fail when the job's site has no
//     online agent — an unstaffed/misconfigured site. Long enough to survive a
//     routine agent restart or host reboot, short enough to give the user an
//     actionable "no agent for site X" result in minutes, not a full day.
//   - PENDING_MAX_WAIT_MINUTES: absolute backstop for anything the fast-fail
//     misses (site has an online agent that somehow never claims the job).
const PENDING_NO_AGENT_TIMEOUT_MINUTES = 15;
const PENDING_MAX_WAIT_MINUTES = 24 * 60;
const REAP_SETTLE_LOOKBACK_MINUTES = 15; // window for the prompt reap-settle sweep
// Skip jobs that turned terminal within the last minute: the complete route commits
// `completed` before it writes the eval-result row, so a sweep in that window would
// refund a job that yields a valid result an instant later (GitHub #90). One minute
// is far longer than the finalize→result gap and well inside the 15-min lookback.
// MUST stay < REAP_SETTLE_LOOKBACK_MINUTES: the sweep selects completed_at in
// [now-lookback, now-grace], so grace ≥ lookback yields an empty range and silently
// disables the catch-up path entirely.
const REAP_SETTLE_GRACE_MINUTES = 1;

const app = express();
const httpServer = createServer(app);

// Security headers (CSP disabled — Vite injects inline scripts, shadcn/ui uses inline styles)
app.use(helmet({ contentSecurityPolicy: false }));

// Trust proxy when behind reverse proxy (Coolify, nginx, etc.)
if (process.env["NODE_ENV"] === "production") {
  app.set("trust proxy", 1);
}

const PgSession = connectPgSimple(session);
const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL });

// Determine cookie security at runtime (bracket notation prevents esbuild inlining)
// COOKIE_SECURE: "true" = always secure, "false" = never secure, unset = auto (production only)
const cookieSecureEnv = process.env["COOKIE_SECURE"];
const isSecureCookie = cookieSecureEnv === "true" ? true
  : cookieSecureEnv === "false" ? false
  : process.env["NODE_ENV"] === "production";

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret && process.env["NODE_ENV"] === "production") {
  throw new Error("SESSION_SECRET environment variable is required in production");
}

app.use(
  session({
    store: new PgSession({
      pool: sessionPool,
      tableName: "user_sessions",
      createTableIfMissing: false, // Table created via Drizzle schema
    }),
    secret: sessionSecret || "vox-dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isSecureCookie,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

// Initialize Passport for OAuth
app.use(passport.initialize());
app.use(passport.session());

// Initialize Google OAuth if credentials are configured
const googleOAuthEnabled = initializeGoogleOAuth();
if (googleOAuthEnabled) {
  console.log("Google OAuth initialized successfully");
}


declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Rate limiting only applies in production
const isProduction = process.env["NODE_ENV"] === "production";

// Runtime kill-switch for local/dev containers. `isProduction` above is baked
// to a constant `true` at esbuild time (scripts/build.ts inlines NODE_ENV), so
// the compiled bundle can't tell a dev Docker container apart from prod — the
// container's NODE_ENV=development is dead. This var is a genuine RUNTIME read
// (esbuild only inlines NODE_ENV), and must be the literal "true" to disable.
// Prod never sets it → rate limiting stays on; only docker-compose (dev) opts out.
const rateLimitDisabled = process.env["RATE_LIMIT_DISABLED"] === "true";

// Paths exempt from rate limiting (lightweight read-only checks)
const rateLimitExempt = new Set(["/api/auth/status", "/api/auth/google/status", "/api/auth/github/status"]);

// Rate limiting for API routes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (req) => rateLimitDisabled || !isProduction || !req.path.startsWith("/api") || rateLimitExempt.has(req.path),
});

// Stricter rate limit for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts, please try again later." },
  skip: () => rateLimitDisabled || !isProduction,
});

app.use(apiLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/activate", authLimiter);
// change-password verifies the current password via bcrypt — an online
// brute-force surface, so it belongs on the strict auth limiter, not the loose
// /api/* one.
app.use("/api/user/change-password", authLimiter);

// API key authentication middleware (checks Bearer token for vox_live_ prefix)
app.use(authenticateApiKey);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

const SENSITIVE_PATHS = new Set([
  "/api/user/api-keys",
  "/api/admin/eval-agent-tokens",
  "/api/admin/invite",
  "/api/secrets",
  "/api/eval-agent/jobs",       // /jobs/:id/secrets matched by startsWith
  "/api/clash-runner/secrets",
  "/api/admin/clash-runner-tokens",
]);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      const isSensitive = SENSITIVE_PATHS.has(path) ||
        Array.from(SENSITIVE_PATHS).some(p => path.startsWith(p));
      if (capturedJsonResponse && !isSensitive) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);
  setupClashWebSocket(httpServer);

  // Load enabled plugins (routes mounted before the error handler + vite catch-all).
  // Any misconfiguration throws here — fail-before-listen (strict startup).
  const plugins = await loadPlugins(app, pool);
  setMarketplace(plugins.services.optional<EvalMarketplace>("vox.eval-marketplace", "^1.0.0"));

  // Graceful shutdown: stop workers and deactivate plugins in reverse order.
  // Guard against re-entrancy — two signals in quick succession must not run the
  // stop/deactivate sequence twice concurrently.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await plugins.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    console.error(err);
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);

      // Start background worker for stale job detection and agent status
      startBackgroundWorker();

    },
  );
})();

// Background worker for eval agent system maintenance
function startBackgroundWorker() {
  const STALE_THRESHOLD_MINUTES = 5;
  const CHECK_INTERVAL_MS = 60 * 1000; // Run every minute

  async function runMaintenanceTasks() {
    try {
      // Release stale jobs (jobs where agent hasn't sent heartbeat)
      const releasedJobs = await storage.releaseStaleJobs(STALE_THRESHOLD_MINUTES);
      if (releasedJobs > 0) {
        log(`Released ${releasedJobs} stale job(s)`, "worker");
      }

      // Fail jobs stuck "running" past the global hard cap (agent zombied/
      // superseded, so the heartbeat check above never catches them).
      const timedOut = await storage.failTimedOutRunningJobs(MAX_JOB_RUN_MINUTES);
      if (timedOut > 0) {
        log(`Failed ${timedOut} job(s) exceeding ${MAX_JOB_RUN_MINUTES}min run time`, "worker");
      }

      // Fast-fail pending jobs whose site has no online agent (run before the
      // backstop so those get the clearer "no agent for site" reason).
      const noAgent = await storage.failPendingJobsWithNoAgent(
        PENDING_NO_AGENT_TIMEOUT_MINUTES,
        STALE_THRESHOLD_MINUTES,
      );
      if (noAgent > 0) {
        log(`Failed ${noAgent} pending job(s) with no agent for their site`, "worker");
      }

      // Backstop: fail any pending job that has waited past the hard cap.
      const expired = await storage.failExpiredPendingJobs(PENDING_MAX_WAIT_MINUTES);
      if (expired > 0) {
        log(`Failed ${expired} pending job(s) exceeding ${PENDING_MAX_WAIT_MINUTES}min wait`, "worker");
      }

      // Mark offline agents
      const offlineAgents = await storage.markOfflineAgents(STALE_THRESHOLD_MINUTES);
      if (offlineAgents > 0) {
        log(`Marked ${offlineAgents} agent(s) as offline`, "worker");
      }

      // Mark offline brokers (row kept — never deleted)
      const offlineBrokers = await storage.markStaleBrokersOffline(STALE_THRESHOLD_MINUTES);
      if (offlineBrokers > 0) {
        log(`Marked ${offlineBrokers} broker(s) as offline`, "worker");
      }

      // Promptly settle shared-dispatch escrow for recently-terminal targeted jobs:
      // capture on `completed`, release on `failed`. This is the prompt path so a
      // completed-but-unsettled job (complete-route settle threw) is captured here,
      // not eventually released by the 26h leak-reaper. No-op when the marketplace
      // seam is absent; settle() is idempotent, so re-visiting a settled job is cheap.
      const marketplace = getMarketplace();
      if (marketplace) {
        const REAP_SETTLE_BATCH = 200;
        const reapable = await storage.getReapableSharedJobs(REAP_SETTLE_LOOKBACK_MINUTES, REAP_SETTLE_GRACE_MINUTES, REAP_SETTLE_BATCH);
        // Honest saturation signal (not a cry-wolf): a FULL batch alone is normal —
        // settled jobs stay query-eligible (no settled-marker yet), so ~lookback×rate
        // rows always sit in the window even when we're keeping up. The real danger is
        // only when the batch is full AND its oldest row (front of the oldest-first
        // scan) is within 2 min of falling out of the lookback window — that means the
        // rows behind the batch cap are even older and will age out to the 26h
        // leak-reaper unsettled. Warn only then; stays quiet under healthy throughput.
        // The cure (stop settled rows consuming the batch) is a settled-marker
        // follow-up — see GitHub #90.
        const oldestCompletedAt = reapable[0]?.completedAt;
        if (
          reapable.length === REAP_SETTLE_BATCH &&
          oldestCompletedAt &&
          oldestCompletedAt.getTime() < Date.now() - (REAP_SETTLE_LOOKBACK_MINUTES - 2) * 60 * 1000
        ) {
          log(`Reap-settle sweep is falling behind — oldest of ${REAP_SETTLE_BATCH} batched jobs is near the ${REAP_SETTLE_LOOKBACK_MINUTES}min lookback edge; jobs behind the cap may age out unsettled`, "worker");
        }
        for (const job of reapable) {
          try {
            // Pass the artifact gate (hasResult) so a completed-but-resultless job
            // refunds instead of paying out on a bare self-report (review H1).
            const hasResult = await storage.hasEvalResult(job.id);
            await marketplace.settle({
              jobId: job.id,
              status: job.status,
              hasResult,
              settlementContext: (job.snapshot as { settlementContext?: unknown } | null)?.settlementContext,
            });
          } catch (settleErr) {
            console.error(`Reap settlement failed for job ${job.id}:`, settleErr);
          }
        }
      }
    } catch (error) {
      console.error("Background worker error:", error);
    }
  }

  async function processScheduledJobs() {
    try {
      // Get all due schedules
      const dueSchedules = await storage.getDueSchedules();

      for (const schedule of dueSchedules) {
        try {
          // Expired schedules stop firing (kept enabled so an Extend resumes them
          // without re-enabling). getDueSchedules already filters these in SQL;
          // this guard covers the query→loop race and avoids the fetches below.
          if (schedule.expiresAt && schedule.expiresAt.getTime() <= Date.now()) {
            continue;
          }
          // A schedule whose workflow or eval-set was deleted (FK SET NULL) can never
          // run — DISABLE it so it isn't re-selected on every tick (zombie). It stays
          // in the list (with a placeholder) for the user to clean up.
          const workflow = schedule.workflowId != null ? await storage.getWorkflow(schedule.workflowId) : undefined;
          const evalSet = schedule.evalSetId != null ? await storage.getEvalSet(schedule.evalSetId) : undefined;
          if (!workflow || !evalSet) {
            log(`Schedule "${schedule.name}" references a deleted workflow/eval-set — disabling`, "scheduler");
            await storage.updateEvalSchedule(schedule.id, { isEnabled: false });
            continue;
          }
          // Re-check at runtime that the schedule's creator may still schedule
          // this workflow (secrets resolve from the workflow owner). This disables
          // schedules whose creator lost the right — e.g. legacy ones created by a
          // system admin on someone else's workflow before scheduling was
          // restricted to the owner — so they stop spending the owner's secrets.
          if (schedule.createdBy == null || !canScheduleWorkflow({ id: schedule.createdBy }, workflow)) {
            log(`Schedule "${schedule.name}" creator is no longer authorized to schedule its workflow — disabling`, "scheduler");
            await storage.updateEvalSchedule(schedule.id, { isEnabled: false });
            continue;
          }
          const provider = await storage.getProvider(workflow.providerId);
          const creator = schedule.createdBy ? await storage.getUser(schedule.createdBy) : undefined;

          // scheduled jobs are inherently owner-dispatched —
          // canScheduleWorkflow (re-checked above) is owner/creator-only, so the
          // schedule creator IS the workflow owner and the untargeted owner/team
          // gate the run route applies is satisfied structurally. stampOwnerSession
          // (shared with the run-now route) strips/stamps config.sessionInjection,
          // pre-warms the mint, and returns the immutable snapshot stamp so
          // /session derives from it, not live data. A split-class credential pair
          // can never run safely (it would leak the runtime-class secret) — disable
          // the schedule so it stops firing failing/unsafe jobs every tick.
          const jobConfig = mergeEvalConfig(workflow.config, evalSet?.config);
          // The workflow's secrets are mutable after schedule creation: a
          // public/team schedule whose workflow LATER gained a login-class
          // secret would emit an unclaimable session job every tick (the claim
          // predicate refuses them, and pooled rows ride the 24h backstop).
          // Check with the PURE detector BEFORE stampOwnerSession — the stamp
          // helper mutates config and pre-warms a broker mint (ensureSession),
          // and a schedule we are about to disable must not burn a login
          // attempt first.
          const schedSessionReq = await detectSessionNeed(workflow);
          if (schedSessionReq.kind === "need") {
            const violation = sessionPoolViolation(schedule.targetTier, workflow, creator);
            if (violation) {
              log(`Schedule "${schedule.name}" would dispatch into a disallowed pool (${violation}) — disabling`, "scheduler");
              await storage.updateEvalSchedule(schedule.id, { isEnabled: false });
              continue;
            }
          }
          // A secret the workflow references can be deleted AFTER the schedule
          // was created; every tick would then emit a job that can only fail on
          // an unresolved ${secrets.X}. Mirror the misconfigured/pool handling:
          // disable the schedule with a named reason instead of queueing doomed
          // work forever. This keys on whether the secret ROW exists, not on
          // whether it reaches the agent — so a brokered login secret that
          // exists is fine (Core mints from it), and one that doesn't is
          // correctly flagged, since the mint would fail too.
          {
            const missing = await missingSecretNames(sessionScopeForWorkflow(workflow), [workflow.config, evalSet?.config]);
            if (missing.length > 0) {
              log(`Schedule "${schedule.name}" references unconfigured secret(s) ${missing.join(", ")} — disabling`, "scheduler");
              await storage.updateEvalSchedule(schedule.id, { isEnabled: false });
              continue;
            }
          }
          const stamp = await stampOwnerSession(workflow, jobConfig as Record<string, unknown>, schedSessionReq);
          if (stamp.kind === "misconfigured") {
            log(`Schedule "${schedule.name}" workflow has a split-class credential pair (${stamp.reason}) — disabling`, "scheduler");
            await storage.updateEvalSchedule(schedule.id, { isEnabled: false });
            continue;
          }
          const baseSnapshot = buildJobSnapshot(workflow, evalSet, provider, creator?.plan ?? null);
          const snapshot = stamp.snapshotInjection
            ? { ...baseSnapshot, sessionInjection: stamp.snapshotInjection }
            : baseSnapshot;

          // Create the eval job
          const job = await storage.createEvalJob({
            scheduleId: schedule.id,
            triggerType: 1, // scheduled
            workflowId: schedule.workflowId,
            evalSetId: schedule.evalSetId,
            createdBy: schedule.createdBy,
            siteId: null,
            targetRegion: schedule.region,
            targetTier: schedule.targetTier,
            config: jobConfig,
            snapshot,
            status: "pending",
            priority: 0,
            retryCount: 0,
            maxRetries: 3,
          });

          log(`Created job ${job.id} from schedule "${schedule.name}" (${schedule.scheduleType})`, "scheduler");

          // Calculate next run time
          let nextRunAt: Date | null = null;

          if (schedule.scheduleType === "recurring" && schedule.cronExpression) {
            // Check if max runs reached
            const newRunCount = schedule.runCount + 1;
            if (schedule.maxRuns && newRunCount >= schedule.maxRuns) {
              // Max runs reached, disable the schedule
              await storage.disableSchedule(schedule.id);
              log(`Schedule "${schedule.name}" disabled (max runs reached: ${schedule.maxRuns})`, "scheduler");
            } else {
              // Calculate next run time from cron expression
              nextRunAt = parseNextCronRun(schedule.cronExpression);
            }
          } else {
            // One-time schedule, disable after running
            await storage.disableSchedule(schedule.id);
            log(`One-time schedule "${schedule.name}" completed and disabled`, "scheduler");
          }

          // Update schedule with new run count and next run time
          if (nextRunAt) {
            await storage.markScheduleRun(schedule.id, nextRunAt);
            log(`Schedule "${schedule.name}" next run at ${nextRunAt.toISOString()}`, "scheduler");
          }
        } catch (error) {
          console.error(`Failed to process schedule ${schedule.id}:`, error);
        }
      }
    } catch (error) {
      console.error("Scheduler error:", error);
    }
  }

  // Run immediately on startup, then every minute
  runMaintenanceTasks();
  processScheduledJobs();
  setInterval(runMaintenanceTasks, CHECK_INTERVAL_MS);
  setInterval(processScheduledJobs, CHECK_INTERVAL_MS);

  log("Background worker started (stale job detection + job scheduler)", "worker");
}
