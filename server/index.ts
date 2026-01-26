import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import { authenticateApiKey, passport, initializeGoogleOAuth } from "./auth";
import { storage } from "./storage";
import pkg from "pg";
const { Pool } = pkg;

const app = express();
const httpServer = createServer(app);

const PgSession = connectPgSimple(session);
const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL });

// Determine cookie security at runtime (bracket notation prevents esbuild inlining)
// COOKIE_SECURE: "true" = always secure, "false" = never secure, unset = auto (production only)
const cookieSecureEnv = process.env["COOKIE_SECURE"];
const isSecureCookie = cookieSecureEnv === "true" ? true
  : cookieSecureEnv === "false" ? false
  : process.env["NODE_ENV"] === "production";

app.use(
  session({
    store: new PgSession({
      pool: sessionPool,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || "vox-dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isSecureCookie,
      httpOnly: true,
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
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Rate limiting for API routes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (req) => !req.path.startsWith("/api"), // Only apply to /api routes
});

// Stricter rate limit for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 auth requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts, please try again later." },
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
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
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

      // Mark offline agents
      const offlineAgents = await storage.markOfflineAgents(STALE_THRESHOLD_MINUTES);
      if (offlineAgents > 0) {
        log(`Marked ${offlineAgents} agent(s) as offline`, "worker");
      }
    } catch (error) {
      console.error("Background worker error:", error);
    }
  }

  // Run immediately on startup, then every minute
  runMaintenanceTasks();
  setInterval(runMaintenanceTasks, CHECK_INTERVAL_MS);

  log("Background worker started (stale job detection)", "worker");
}
