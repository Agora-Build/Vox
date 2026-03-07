import express, { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import { authenticateApiKey, passport, initializeGoogleOAuth } from "./auth";
import { storage, mergeEvalConfig, db, pool } from "./storage";
import { parseNextCronRun } from "./cron";
import { seedFromLocalAevalData } from "./aeval-seed";
import pkg from "pg";
const { Pool } = pkg;

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

// Paths exempt from rate limiting (lightweight read-only checks)
const rateLimitExempt = new Set(["/api/auth/status", "/api/auth/google/status", "/api/auth/github/status"]);

// Rate limiting for API routes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (req) => !isProduction || !req.path.startsWith("/api") || rateLimitExempt.has(req.path),
});

// Stricter rate limit for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts, please try again later." },
  skip: () => !isProduction,
});

app.use(apiLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/activate", authLimiter);

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
  // Sync database schema on startup using drizzle-kit push (idempotent, diff-based)
  try {
    const { execSync } = await import("child_process");
    execSync("npx drizzle-kit push --force", { stdio: "inherit" });
    log("Database schema synced", "db");
  } catch (err) {
    console.error("Failed to sync database schema:", err);
    process.exit(1);
  }

  // Ensure new columns exist (fallback for drizzle-kit edge cases)
  try {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`
      ALTER TABLE eval_jobs ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id)
    `);
    await pool.end();
  } catch (err) {
    // Column already exists or other non-fatal issue
    console.warn("Schema fallback check:", err);
  }

  await registerRoutes(httpServer, app);

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

      // Auto-seed built-in aeval data if available
      seedFromLocalAevalData().catch((err) =>
        console.error("[aeval-seed] Startup seed error:", err),
      );
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

      // Mark offline agents
      const offlineAgents = await storage.markOfflineAgents(STALE_THRESHOLD_MINUTES);
      if (offlineAgents > 0) {
        log(`Marked ${offlineAgents} agent(s) as offline`, "worker");
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
          // Fetch workflow + evalSet to merge configs
          const workflow = await storage.getWorkflow(schedule.workflowId);
          if (!workflow) {
            log(`Schedule "${schedule.name}" references deleted workflow ${schedule.workflowId}, skipping`, "scheduler");
            continue;
          }
          const evalSet = await storage.getEvalSet(schedule.evalSetId);

          // Create the eval job
          const job = await storage.createEvalJob({
            scheduleId: schedule.id,
            workflowId: schedule.workflowId,
            evalSetId: schedule.evalSetId,
            createdBy: schedule.createdBy,
            region: schedule.region,
            config: mergeEvalConfig(workflow.config, evalSet?.config),
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
