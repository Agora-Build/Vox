import express, { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { isSensitiveResponsePath } from "./sensitive-paths";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import { authenticateApiKey, passport, initializeGoogleOAuth } from "./auth";
import { pool } from "./storage";
import { startLocationServices } from "./location";
import { setupClashWebSocket } from "./clash-ws";
import { loadPlugins } from "./plugins/loader";
import { setMarketplace, type EvalMarketplace } from "./marketplace";
import { setOrganizations, type OrganizationsProvider } from "./organizations";
import { processScheduledJobs, runMaintenanceTasks } from "./scheduler";
import { log } from "./log";
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

// Moved to server/log.ts (so the background workers can log without importing
// this entry point); re-exported here to keep the existing import path valid.
export { log };


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
      const isSensitive = isSensitiveResponsePath(path);
      if (capturedJsonResponse && !isSensitive) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // storage is ready as soon as the module graph loads (importing `pool` above
  // pulls it in); start mmdb/Tor/ASN loaders before routes so early requests get a
  // (possibly still-loading) detection shell rather than a crash.
  startLocationServices();

  await registerRoutes(httpServer, app);
  setupClashWebSocket(httpServer);

  // Load enabled plugins (routes mounted before the error handler + vite catch-all).
  // Any misconfiguration throws here — fail-before-listen (strict startup).
  const plugins = await loadPlugins(app, pool);
  setMarketplace(plugins.services.optional<EvalMarketplace>("vox.eval-marketplace", "^1.0.0"));

  // Organizations: PLUGIN-OR-ABSENT (Release A flip). The `organizations`
  // plugin owns membership/org/org-secret data; there is no Core fallback
  // anymore — `CoreOrganizations` is deleted, deliberately: after the copy
  // migration the Core columns are frozen, so a fallback would answer
  // authorization questions from pre-cutover data (design §6). An instance
  // without the plugin in VOX_PLUGINS gets genuine absence: the org feature is
  // INERT (501s, scheduler skips, fences fail closed — server/organizations.ts
  // §7), never silently stale.
  setOrganizations(
    plugins.services.optional<OrganizationsProvider>("vox.organizations", "^1.0.0") ?? null,
  );

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

// Background worker for eval agent system maintenance. The ticks themselves
// live in server/scheduler.ts; this is only the wiring.
function startBackgroundWorker() {
  const CHECK_INTERVAL_MS = 60 * 1000; // Run every minute

  // Run immediately on startup, then every minute
  runMaintenanceTasks();
  processScheduledJobs();
  setInterval(runMaintenanceTasks, CHECK_INTERVAL_MS);
  setInterval(processScheduledJobs, CHECK_INTERVAL_MS);

  log("Background worker started (stale job detection + job scheduler)", "worker");
}

