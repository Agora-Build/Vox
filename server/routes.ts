import type { Express } from "express";
import { type Server } from "http";
import { storage, hashToken, generateSecureToken, generateEvalAgentToken, mergeEvalConfig, buildJobSnapshot, validateWorkflowConfig, validateEvalSetConfig, encryptValue, decryptValue, isEncryptionConfigured, type MetricSourceRow } from "./storage";
import { parseNextCronRun } from "./cron";
import { compareVersions } from "./aeval-seed";
import { SECRET_NAME_PATTERN } from "@shared/secrets";
import { registerApiV1Routes } from "./routes-api-v1";
import { generateSignedUrlForUser } from "./s3";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  getInitCode,
  isSystemInitialized,
  markSystemInitialized,
  getCurrentUser,
  requireAuth,
  requireAdmin,
  requirePrincipal,
  requireOrgAdmin,
  requireAuthOrApiKey,
  generateApiKey,
  passport,
  getGithubOAuthUrl,
  exchangeGithubCode,
  getGithubProfile,
  findOrCreateGithubUser,
} from "./auth";
import { calculateSeatPrice } from "./pricing";
import {
  isAgoraConfigured,
  isModeratorConfigured,
  generateRtcToken,
  generateEventChannelName,
  startModerator,
  stopModerator,
  speakModerator,
  buildAnnouncementPrompt,
  buildBriefingPrompt,
  buildStartPrompt,
  buildEndPrompt,
} from "./agora";
import {
  isStripeConfigured,
  isStripeTestMode,
  createStripeCustomer,
  createSetupIntent,
  createPaymentIntent,
  getPaymentMethodDetails,
  attachPaymentMethod,
  detachPaymentMethod,
  constructWebhookEvent,
  getStripePublishableKey,
} from "./stripe";

// Org resource permission helpers live in ./permissions so the background
// scheduler shares the exact same authorization logic as the API.
import {
  canAccessResource,
  canEditResource,
  isOwnerOrOrgManager,
  canRunWorkflow,
  canScheduleWorkflow,
} from "./permissions";

// Schedule lifecycle: a schedule is created with a 90-day expiry and can be
// Extended by the same window. Past expiry the scheduler stops firing it.
const SCHEDULE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// Elo rating calculation for Clash matches
// Lower latency = better. Compare median response latency to determine winner.
async function updateClashEloRatings(
  agentAId: number,
  agentBId: number,
  metricsA: { responseLatencyMedian?: number | null; turnCount?: number | null },
  metricsB: { responseLatencyMedian?: number | null; turnCount?: number | null },
) {
  const K = 32; // Standard Elo K-factor

  const ratingA = await storage.getClashEloRating(agentAId);
  const ratingB = await storage.getClashEloRating(agentBId);
  const ra = ratingA?.rating ?? 1500;
  const rb = ratingB?.rating ?? 1500;

  // Expected scores
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  const eb = 1 / (1 + Math.pow(10, (ra - rb) / 400));

  // Determine outcome: lower latency wins, draw if within 10%
  let sa: number, sb: number;
  let aWin = 0, aLoss = 0, aDraw = 0;
  let bWin = 0, bLoss = 0, bDraw = 0;

  const latA = metricsA.responseLatencyMedian;
  const latB = metricsB.responseLatencyMedian;

  if (latA != null && latB != null && latA > 0 && latB > 0) {
    const ratio = latA / latB;
    if (ratio < 0.9) {
      // A wins (lower latency)
      sa = 1; sb = 0; aWin = 1; bLoss = 1;
    } else if (ratio > 1.1) {
      // B wins
      sa = 0; sb = 1; aLoss = 1; bWin = 1;
    } else {
      // Draw
      sa = 0.5; sb = 0.5; aDraw = 1; bDraw = 1;
    }
  } else {
    // Can't determine, draw
    sa = 0.5; sb = 0.5; aDraw = 1; bDraw = 1;
  }

  const newRa = Math.round(ra + K * (sa - ea));
  const newRb = Math.round(rb + K * (sb - eb));

  await storage.upsertClashEloRating(agentAId, {
    rating: newRa,
    matchCount: (ratingA?.matchCount ?? 0) + 1,
    winCount: (ratingA?.winCount ?? 0) + aWin,
    lossCount: (ratingA?.lossCount ?? 0) + aLoss,
    drawCount: (ratingA?.drawCount ?? 0) + aDraw,
  });

  await storage.upsertClashEloRating(agentBId, {
    rating: newRb,
    matchCount: (ratingB?.matchCount ?? 0) + 1,
    winCount: (ratingB?.winCount ?? 0) + bWin,
    lossCount: (ratingB?.lossCount ?? 0) + bLoss,
    drawCount: (ratingB?.drawCount ?? 0) + bDraw,
  });
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // ==================== AUTH ROUTES ====================

  app.get("/api/auth/status", async (req, res) => {
    try {
      const initialized = await isSystemInitialized();
      const user = await getCurrentUser(req);
      res.json({
        initialized,
        user: user ? {
          id: user.id,
          username: user.username,
          email: user.email,
          plan: user.plan,
          isAdmin: user.isAdmin,
          isEnabled: user.isEnabled,
          emailVerified: !!user.emailVerifiedAt,
          organizationId: user.organizationId,
          orgRole: user.orgRole,
          hasPassword: !!user.passwordHash,
        } : null
      });
    } catch (error) {
      console.error("Error getting auth status:", error);
      res.status(500).json({ error: "Failed to get auth status" });
    }
  });

  app.post("/api/auth/init", async (req, res) => {
    try {
      const initialized = await isSystemInitialized();
      if (initialized) {
        return res.status(400).json({ error: "System already initialized" });
      }

      const { code, adminEmail, adminPassword, adminUsername } = req.body;
      
      if (!code || !adminEmail || !adminPassword || !adminUsername) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      if (adminPassword.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      const expectedCode = getInitCode();
      if (code !== expectedCode) {
        return res.status(403).json({ error: "Invalid initialization code" });
      }

      const existingUser = await storage.getUserByEmail(adminEmail);
      if (existingUser) {
        return res.status(400).json({ error: "Email already registered" });
      }

      const existingUsername = await storage.getUserByUsername(adminUsername);
      if (existingUsername) {
        return res.status(400).json({ error: "Username already taken" });
      }

      const passwordHash = await hashPassword(adminPassword);
      
      const admin = await storage.createUser({
        username: adminUsername,
        email: adminEmail,
        passwordHash,
        plan: "principal",
        isAdmin: true,
        isEnabled: true,
        emailVerifiedAt: new Date(),
      });

      const scout = await storage.createUser({
        username: "Scout",
        email: "scout@vox.internal",
        passwordHash: null,
        plan: "principal",
        isAdmin: false,
        isEnabled: false,
        emailVerifiedAt: null,
      });

      // Create default providers (ID is generated automatically).
      // Idempotent by name: `npm start` runs the migration runner BEFORE the app,
      // so on a fresh instance any seed-inserting migration has already run first
      // (0003 → ElevenLabs, 0014 → Custom). init is a post-boot call, so it must
      // skip providers that already exist — otherwise a brand-new instance ends up
      // with duplicate rows. Covers every seed-migrated provider, not just Custom.
      const seedProviders = [
        { name: "Agora ConvoAI Engine", sku: "convoai" as const, description: "Agora's Conversational AI Engine", brandColor: "#099DFD", platformId: "agora" },
        { name: "LiveKit Agents", sku: "convoai" as const, description: "LiveKit's Real-time Communication Agents", brandColor: "#1FD5F9", platformId: "livekit" },
        { name: "ElevenLabs Agents", sku: "convoai" as const, description: "ElevenLabs Conversational AI Agents", brandColor: "#A8A29E", platformId: "elevenlabs" },
        { name: "Custom", sku: "convoai" as const, description: "Custom / self-hosted conversational AI agent" },
      ];
      for (const p of seedProviders) {
        // getProviderByName is unfiltered by isActive, so a deactivated seed
        // provider can't slip past the guard and create a duplicate row.
        const existing = await storage.getProviderByName(p.name);
        if (!existing) await storage.createProvider(p);
      }

      // Set default pricing config (prices in cents)
      await storage.setPricingConfig({ name: "Solo Premium", pricePerSeat: 500, minSeats: 1, maxSeats: 1, discountPercent: 0, isActive: true });
      await storage.setPricingConfig({ name: "Org Premium (1-2 seats)", pricePerSeat: 600, minSeats: 1, maxSeats: 2, discountPercent: 0, isActive: true });
      await storage.setPricingConfig({ name: "Org Premium (3-5 seats)", pricePerSeat: 600, minSeats: 3, maxSeats: 5, discountPercent: 10, isActive: true });
      await storage.setPricingConfig({ name: "Org Premium (6-10 seats)", pricePerSeat: 600, minSeats: 6, maxSeats: 10, discountPercent: 15, isActive: true });
      await storage.setPricingConfig({ name: "Org Premium (11+ seats)", pricePerSeat: 600, minSeats: 11, maxSeats: 9999, discountPercent: 25, isActive: true });

      await markSystemInitialized();

      req.session.userId = admin.id;

      res.json({ 
        message: "System initialized successfully",
        admin: { id: admin.id, username: admin.username, email: admin.email },
        scout: { id: scout.id, username: scout.username },
      });
    } catch (error) {
      console.error("Error initializing system:", error);
      res.status(500).json({ error: "Failed to initialize system" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      
      if (!email || !password) {
        return res.status(400).json({ error: "Email and password required" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      if (!user.isEnabled) {
        return res.status(403).json({ error: "Account is disabled" });
      }

      if (!user.passwordHash) {
        return res.status(401).json({ error: "Account requires activation" });
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      req.session.userId = user.id;

      // Explicitly save session to ensure cookie is set before response
      req.session.save((err) => {
        if (err) {
          console.error("Error saving session:", err);
          return res.status(500).json({ error: "Failed to save session" });
        }
        res.json({
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            plan: user.plan,
            isAdmin: user.isAdmin,
            emailVerified: !!user.emailVerifiedAt,
          }
        });
      });
    } catch (error) {
      console.error("Error logging in:", error);
      res.status(500).json({ error: "Failed to login" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Failed to logout" });
      }
      res.json({ message: "Logged out successfully" });
    });
  });

  // ==================== GOOGLE OAUTH ROUTES ====================

  // Check if Google OAuth is available
  app.get("/api/auth/google/status", (req, res) => {
    const enabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    res.json({ enabled });
  });

  // Initiate Google OAuth flow
  app.get(
    "/api/auth/google",
    (req, res, next) => {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        return res.status(503).json({ error: "Google OAuth not configured" });
      }
      next();
    },
    passport.authenticate("google", { scope: ["profile", "email"] })
  );

  // Handle Google OAuth callback
  app.get(
    "/api/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/login?error=oauth_failed" }),
    (req, res) => {
      // Successful authentication - set session and redirect
      if (req.user) {
        const user = req.user as { id: number };
        req.session.userId = user.id;
      }
      // Redirect to console or home page
      res.redirect("/console");
    }
  );

  // ==================== GITHUB OAUTH ROUTES ====================
  // Uses manual code-exchange so the callback URL is a frontend page.

  // Check if GitHub OAuth is available
  app.get("/api/auth/github/status", (req, res) => {
    const enabled = !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
    res.json({ enabled });
  });

  // Initiate GitHub OAuth flow — generate state, redirect to GitHub
  app.get("/api/auth/github", (req, res) => {
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
      return res.status(503).json({ error: "GitHub OAuth not configured" });
    }
    // Clear any existing session so a new GitHub account doesn't inherit the old login
    delete req.session.userId;
    const state = generateToken();
    req.session.githubOAuthState = state;
    const origin = `${req.protocol}://${req.get("host")}`;
    res.redirect(getGithubOAuthUrl(state, origin));
  });

  // Exchange code for user session — called by the frontend callback page
  app.post("/api/auth/github/callback", async (req, res) => {
    try {
      const { code, state } = req.body;
      if (!code || !state) {
        return res.status(400).json({ error: "Missing code or state" });
      }

      // Validate state to prevent CSRF
      if (state !== req.session.githubOAuthState) {
        return res.status(403).json({ error: "Invalid OAuth state" });
      }
      delete req.session.githubOAuthState;

      // Exchange code → access token → profile → user
      const accessToken = await exchangeGithubCode(code);
      const profile = await getGithubProfile(accessToken);
      const user = await findOrCreateGithubUser(profile.id, profile.email, profile.login);

      // Set session
      req.session.userId = user.id;
      res.json({ user: { id: user.id, username: user.username, email: user.email, isAdmin: user.isAdmin } });
    } catch (error: any) {
      console.error("GitHub OAuth callback error:", error);
      res.status(401).json({ error: error.message || "GitHub authentication failed" });
    }
  });

  // ==================== ADMIN USER ROUTES ====================

  app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users.map(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        plan: u.plan,
        isAdmin: u.isAdmin,
        isEnabled: u.isEnabled,
        emailVerified: !!u.emailVerifiedAt,
        organizationId: u.organizationId,
        createdAt: u.createdAt,
      })));
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.patch("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { isEnabled, isAdmin, plan } = req.body;

      // Prevent self-lockout server-side (the UI also disables these toggles for
      // your own row, but that can't be the only guard): an admin can't remove
      // their own admin access or disable their own account. Plan is harmless.
      const currentUser = await getCurrentUser(req);
      if (currentUser && currentUser.id === parseInt(id)) {
        if (isAdmin === false) return res.status(400).json({ error: "You cannot remove your own admin access" });
        if (isEnabled === false) return res.status(400).json({ error: "You cannot disable your own account" });
      }

      const updates: Record<string, unknown> = {};
      if (typeof isEnabled === "boolean") updates.isEnabled = isEnabled;
      if (typeof isAdmin === "boolean") updates.isAdmin = isAdmin;
      if (plan && ["basic", "premium", "principal", "fellow"].includes(plan)) updates.plan = plan;
      
      const updated = await storage.updateUser(parseInt(id), updates);
      if (!updated) {
        return res.status(404).json({ error: "User not found" });
      }
      
      res.json({ 
        id: updated.id,
        username: updated.username,
        email: updated.email,
        plan: updated.plan,
        isAdmin: updated.isAdmin,
        isEnabled: updated.isEnabled,
      });
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  app.post("/api/admin/invite", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { email, plan, isAdmin } = req.body;
      const currentUser = await getCurrentUser(req);
      
      if (!email) {
        return res.status(400).json({ error: "Email required" });
      }

      const existing = await storage.getUserByEmail(email);
      if (existing) {
        return res.status(400).json({ error: "Email already registered" });
      }

      const token = generateToken();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      
      await storage.createInviteToken(
        email, 
        (plan || "basic") as "basic" | "premium" | "principal" | "fellow", 
        isAdmin || false, 
        tokenHash, 
        currentUser?.id || null, 
        expiresAt
      );

      res.json({ 
        message: "Invite created",
        token,
        expiresAt,
      });
    } catch (error) {
      console.error("Error creating invite:", error);
      res.status(500).json({ error: "Failed to create invite" });
    }
  });

  app.post("/api/admin/users/:id/activation-link", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { email } = req.body;
      
      const user = await storage.getUser(parseInt(id));
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (email && email !== user.email) {
        const existingEmail = await storage.getUserByEmail(email);
        if (existingEmail) {
          return res.status(400).json({ error: "Email already in use" });
        }
        await storage.updateUser(parseInt(id), { email });
      }

      const token = generateToken();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      
      await storage.createActivationToken(parseInt(id), tokenHash, expiresAt);

      res.json({ 
        message: "Activation link created",
        token,
        activationUrl: `/activate/${token}`,
        expiresAt,
      });
    } catch (error) {
      console.error("Error creating activation link:", error);
      res.status(500).json({ error: "Failed to create activation link" });
    }
  });

  app.get("/api/auth/activation/:token", async (req, res) => {
    try {
      const { token } = req.params;
      const tokenHash = hashToken(token);
      
      const activation = await storage.getActivationTokenByHash(tokenHash);
      if (!activation) {
        return res.status(400).json({ error: "Invalid activation token" });
      }
      
      if (activation.usedAt) {
        return res.status(400).json({ error: "Activation link already used" });
      }
      
      if (new Date() > activation.expiresAt) {
        return res.status(400).json({ error: "Activation link expired" });
      }

      const user = await storage.getUser(activation.userId);
      if (!user) {
        return res.status(400).json({ error: "User not found" });
      }

      res.json({ 
        valid: true,
        username: user.username,
        email: user.email,
      });
    } catch (error) {
      console.error("Error verifying activation token:", error);
      res.status(500).json({ error: "Failed to verify activation token" });
    }
  });

  app.post("/api/auth/activate", async (req, res) => {
    try {
      const { token, password } = req.body;
      
      if (!token || !password) {
        return res.status(400).json({ error: "Token and password required" });
      }

      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      const tokenHash = hashToken(token);
      const activation = await storage.getActivationTokenByHash(tokenHash);
      if (!activation) {
        return res.status(400).json({ error: "Invalid activation token" });
      }
      
      if (activation.usedAt) {
        return res.status(400).json({ error: "Activation link already used" });
      }
      
      if (new Date() > activation.expiresAt) {
        return res.status(400).json({ error: "Activation link expired" });
      }

      const passwordHashNew = await hashPassword(password);
      
      await storage.updateUser(activation.userId, { 
        passwordHash: passwordHashNew,
        isEnabled: true,
        emailVerifiedAt: new Date(),
      });

      await storage.markActivationTokenUsed(tokenHash);

      const user = await storage.getUser(activation.userId);

      req.session.userId = activation.userId;

      res.json({ 
        message: "Account activated successfully",
        user: user ? {
          id: user.id,
          username: user.username,
          email: user.email,
          plan: user.plan,
          isAdmin: user.isAdmin,
        } : null,
      });
    } catch (error) {
      console.error("Error activating account:", error);
      res.status(500).json({ error: "Failed to activate account" });
    }
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const { token, username, password } = req.body;
      
      if (!token || !username || !password) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      const tokenHash = hashToken(token);
      const invite = await storage.getInviteTokenByHash(tokenHash);
      if (!invite) {
        return res.status(400).json({ error: "Invalid invite token" });
      }
      
      if (invite.usedAt) {
        return res.status(400).json({ error: "Invite already used" });
      }
      
      if (new Date() > invite.expiresAt) {
        return res.status(400).json({ error: "Invite expired" });
      }

      const existingUsername = await storage.getUserByUsername(username);
      if (existingUsername) {
        return res.status(400).json({ error: "Username already taken" });
      }

      const passwordHashNew = await hashPassword(password);
      
      const user = await storage.createUser({
        username,
        email: invite.email,
        passwordHash: passwordHashNew,
        plan: invite.plan as "basic" | "premium" | "principal" | "fellow",
        isAdmin: invite.isAdmin,
        isEnabled: true,
        emailVerifiedAt: new Date(),
        organizationId: invite.organizationId,
        orgRole: invite.organizationId ? 'member' : null,
      });

      await storage.markInviteTokenUsed(tokenHash);

      req.session.userId = user.id;

      res.json({ 
        user: { 
          id: user.id, 
          username: user.username, 
          email: user.email,
          plan: user.plan, 
          isAdmin: user.isAdmin,
        } 
      });
    } catch (error) {
      console.error("Error registering:", error);
      res.status(500).json({ error: "Failed to register" });
    }
  });

  // ==================== PROVIDER ROUTES ====================

  app.get("/api/providers", async (req, res) => {
    try {
      const providers = await storage.getAllProviders();
      res.json(providers);
    } catch (error) {
      console.error("Error fetching providers:", error);
      res.status(500).json({ error: "Failed to fetch providers" });
    }
  });

  app.post("/api/providers", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { name, sku, description } = req.body;
      
      if (!name || !sku) {
        return res.status(400).json({ error: "Name and SKU required" });
      }

      if (!["convoai", "rtc"].includes(sku)) {
        return res.status(400).json({ error: "Invalid SKU. Must be convoai or rtc" });
      }

      const provider = await storage.createProvider({
        name,
        sku,
        description,
      });

      res.json(provider);
    } catch (error) {
      console.error("Error creating provider:", error);
      res.status(500).json({ error: "Failed to create provider" });
    }
  });

  app.patch("/api/providers/:id", requireAuthOrApiKey, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, brandColor, platformId, isActive } = req.body;

      const existing = await storage.getProvider(id);
      if (!existing) {
        return res.status(404).json({ error: "Provider not found" });
      }

      if (brandColor !== undefined && brandColor !== null && !/^#[0-9A-Fa-f]{6}$/.test(brandColor)) {
        return res.status(400).json({ error: "brandColor must be a valid hex color (e.g. #099DFD) or null" });
      }

      if (platformId !== undefined && platformId !== null && !/^[a-z0-9_-]+$/.test(platformId)) {
        return res.status(400).json({ error: "platformId must be a lowercase slug (e.g. agora, livekit) or null" });
      }

      const updates: Record<string, unknown> = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (brandColor !== undefined) updates.brandColor = brandColor;
      if (platformId !== undefined) updates.platformId = platformId;
      if (isActive !== undefined) updates.isActive = isActive;

      const updated = await storage.updateProvider(id, updates);
      res.json(updated);
    } catch (error) {
      console.error("Error updating provider:", error);
      res.status(500).json({ error: "Failed to update provider" });
    }
  });

  // ==================== USER PROFILE (SELF) ROUTES ====================

  // Update own display name (username)
  app.patch("/api/user/profile", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { username } = req.body;
      if (typeof username !== "string" || username.trim().length < 2) {
        return res.status(400).json({ error: "Name must be at least 2 characters" });
      }
      const clean = username.trim();
      if (clean.length > 50) return res.status(400).json({ error: "Name must be 50 characters or fewer" });

      const existing = await storage.getUserByUsername(clean);
      if (existing && existing.id !== user.id) {
        return res.status(400).json({ error: "That name is already taken" });
      }

      let updated;
      try {
        updated = await storage.updateUser(user.id, { username: clean });
      } catch (e) {
        // username has a UNIQUE constraint; a concurrent claim races past the
        // check above and surfaces as a Postgres unique violation (23505).
        if (e && typeof e === "object" && (e as { code?: string }).code === "23505") {
          return res.status(400).json({ error: "That name is already taken" });
        }
        throw e;
      }
      if (!updated) return res.status(404).json({ error: "User not found" });
      res.json({ id: updated.id, username: updated.username, email: updated.email, isAdmin: updated.isAdmin });
    } catch (error) {
      console.error("Error updating profile:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // Change own password. If the account has no password yet (OAuth-only), a new
  // one can be set without a current password; otherwise the current is verified.
  app.post("/api/user/change-password", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { currentPassword, newPassword } = req.body;
      if (typeof newPassword !== "string" || newPassword.length < 8) {
        return res.status(400).json({ error: "New password must be at least 8 characters" });
      }

      if (user.passwordHash) {
        if (typeof currentPassword !== "string" || !(await verifyPassword(currentPassword, user.passwordHash))) {
          return res.status(400).json({ error: "Current password is incorrect" });
        }
      }

      // Harden the session BEFORE the irreversible password write, so a failure
      // here returns an error with the password still unchanged (fail closed,
      // consistent state — the old password keeps working on retry). These steps
      // are REQUIRED, not best-effort:
      //   1. Regenerate the caller's own session id (defends against fixation).
      //   2. Revoke every OTHER session for this user (evicts stale/stolen ones).
      await new Promise<void>((resolve, reject) =>
        req.session.regenerate((err) => (err ? reject(err) : resolve())),
      );
      req.session.userId = user.id;
      await new Promise<void>((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve())),
      );
      await storage.deleteOtherUserSessions(user.id, req.sessionID);

      // Commit the new password only after session hardening has succeeded.
      const passwordHash = await hashPassword(newPassword);
      await storage.updateUser(user.id, { passwordHash });

      res.json({ message: "Password updated", hadPassword: !!user.passwordHash });
    } catch (error) {
      console.error("Error changing password:", error);
      res.status(500).json({ error: "Failed to change password" });
    }
  });

  // ==================== API KEY ROUTES ====================

  // List user's API keys
  app.get("/api/user/api-keys", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const keys = await storage.getApiKeysByUser(user.id);
      // Return keys without the hash (only show metadata)
      res.json(keys.map(k => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        usageCount: k.usageCount,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
        isRevoked: k.isRevoked,
        createdAt: k.createdAt,
      })));
    } catch (error) {
      console.error("Error fetching API keys:", error);
      res.status(500).json({ error: "Failed to fetch API keys" });
    }
  });

  // Create a new API key
  app.post("/api/user/api-keys", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { name, expiresInDays } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }

      // Generate the API key with prefix
      const { key, prefix } = generateApiKey();
      const keyHash = hashToken(key);

      // Calculate expiration if provided
      let expiresAt: Date | undefined;
      if (expiresInDays && typeof expiresInDays === "number" && expiresInDays > 0) {
        expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
      }

      const apiKey = await storage.createApiKey({
        name,
        keyHash,
        keyPrefix: prefix,
        createdBy: user.id,
        isRevoked: false,
        expiresAt,
      });

      // Return the full key only once - it cannot be retrieved again
      res.json({
        id: apiKey.id,
        name: apiKey.name,
        key, // Full key - only shown once!
        keyPrefix: apiKey.keyPrefix,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
        message: "Store this key securely - it will not be shown again!",
      });
    } catch (error) {
      console.error("Error creating API key:", error);
      res.status(500).json({ error: "Failed to create API key" });
    }
  });

  // Revoke an API key
  app.post("/api/user/api-keys/:id/revoke", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const apiKey = await storage.getApiKey(parseInt(id));

      if (!apiKey) {
        return res.status(404).json({ error: "API key not found" });
      }

      // Users can only revoke their own keys (unless admin)
      if (apiKey.createdBy !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Not authorized to revoke this key" });
      }

      await storage.revokeApiKey(parseInt(id));
      res.json({ message: "API key revoked successfully" });
    } catch (error) {
      console.error("Error revoking API key:", error);
      res.status(500).json({ error: "Failed to revoke API key" });
    }
  });

  // Delete an API key (hard delete)
  app.delete("/api/user/api-keys/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const apiKey = await storage.getApiKey(parseInt(id));

      if (!apiKey) {
        return res.status(404).json({ error: "API key not found" });
      }

      // Users can only delete their own keys (unless admin)
      if (apiKey.createdBy !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Not authorized to delete this key" });
      }

      await storage.deleteApiKey(parseInt(id));
      res.json({ message: "API key deleted successfully" });
    } catch (error) {
      console.error("Error deleting API key:", error);
      res.status(500).json({ error: "Failed to delete API key" });
    }
  });

  // ==================== USER STORAGE CONFIG ROUTES ====================

  app.get("/api/user/storage-config", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const config = await storage.getUserStorageConfig(user.id);
      if (!config) return res.json(null);

      // Mask sensitive keys
      res.json({
        id: config.id,
        s3Endpoint: config.s3Endpoint,
        s3Bucket: config.s3Bucket,
        s3Region: config.s3Region,
        s3AccessKeyId: "****" + decryptValue(config.s3AccessKeyId).slice(-4),
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
      });
    } catch (error) {
      console.error("Error fetching storage config:", error);
      res.status(500).json({ error: "Failed to fetch storage config" });
    }
  });

  app.put("/api/user/storage-config", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      if (user.plan === "basic") {
        return res.status(403).json({ error: "Premium or higher plan required" });
      }

      const { s3Endpoint, s3Bucket, s3Region, s3AccessKeyId, s3SecretAccessKey } = req.body;
      if (!s3Endpoint || !s3Bucket || !s3AccessKeyId || !s3SecretAccessKey) {
        return res.status(400).json({ error: "s3Endpoint, s3Bucket, s3AccessKeyId, and s3SecretAccessKey are required" });
      }

      const config = await storage.upsertUserStorageConfig(user.id, {
        s3Endpoint,
        s3Bucket,
        s3Region: s3Region || "auto",
        s3AccessKeyId: encryptValue(s3AccessKeyId),
        s3SecretAccessKey: encryptValue(s3SecretAccessKey),
      });

      res.json({ message: "Storage config saved", id: config.id });
    } catch (error) {
      console.error("Error saving storage config:", error);
      res.status(500).json({ error: "Failed to save storage config" });
    }
  });

  app.delete("/api/user/storage-config", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      await storage.deleteUserStorageConfig(user.id);
      res.json({ message: "Storage config removed" });
    } catch (error) {
      console.error("Error removing storage config:", error);
      res.status(500).json({ error: "Failed to remove storage config" });
    }
  });

  // ==================== MOVE RESOURCES TO ORG ====================

  app.post("/api/organizations/move-resources", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!user.organizationId) return res.status(403).json({ error: "Organization membership required" });

      const { projectIds, workflowIds, evalSetIds, scheduleIds } = req.body;
      const orgId = user.organizationId;
      const moved = { projects: 0, workflows: 0, evalSets: 0, schedules: 0 };

      // Move projects (and their child workflows)
      if (Array.isArray(projectIds) && projectIds.length > 0) {
        for (const id of projectIds) {
          const project = await storage.getProject(id);
          if (project && project.ownerId === user.id && !project.organizationId) {
            await storage.updateProject(id, { organizationId: orgId });
            moved.projects++;
            // Move child workflows too
            const childWorkflows = await storage.getWorkflowsByProject(id);
            for (const w of childWorkflows) {
              if (w.ownerId === user.id && !w.organizationId) {
                await storage.updateWorkflow(w.id, { organizationId: orgId });
                moved.workflows++;
              }
            }
          }
        }
      }

      // Move standalone workflows
      if (Array.isArray(workflowIds) && workflowIds.length > 0) {
        for (const id of workflowIds) {
          const workflow = await storage.getWorkflow(id);
          if (workflow && workflow.ownerId === user.id && !workflow.organizationId) {
            await storage.updateWorkflow(id, { organizationId: orgId });
            moved.workflows++;
          }
        }
      }

      // Move eval sets
      if (Array.isArray(evalSetIds) && evalSetIds.length > 0) {
        for (const id of evalSetIds) {
          const evalSet = await storage.getEvalSet(id);
          if (evalSet && evalSet.ownerId === user.id && !evalSet.organizationId) {
            await storage.updateEvalSet(id, { organizationId: orgId });
            moved.evalSets++;
          }
        }
      }

      // Move schedules
      if (Array.isArray(scheduleIds) && scheduleIds.length > 0) {
        for (const id of scheduleIds) {
          const schedule = await storage.getEvalSchedule(id);
          if (schedule && schedule.createdBy === user.id && !schedule.organizationId) {
            await storage.updateEvalSchedule(id, { organizationId: orgId });
            moved.schedules++;
          }
        }
      }

      res.json({ message: "Resources moved to organization", moved });
    } catch (error) {
      console.error("Error moving resources:", error);
      res.status(500).json({ error: "Failed to move resources" });
    }
  });

  // ==================== PROJECT ROUTES ====================

  app.get("/api/projects", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const projects = await storage.getProjectsByOwner(user.id);

      // Add workflow counts
      const projectsWithCounts = await Promise.all(
        projects.map(async (project) => ({
          ...project,
          workflowCount: await storage.countWorkflowsByProject(project.id),
        }))
      );

      res.json(projectsWithCounts);
    } catch (error) {
      console.error("Error fetching projects:", error);
      res.status(500).json({ error: "Failed to fetch projects" });
    }
  });

  app.post("/api/projects", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { name, description } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Name required" });
      }

      // Check project limits
      const projectCount = await storage.countProjectsByOwner(user.id);
      const maxProjects = user.plan === "basic" ? 5 : 20;
      
      if (projectCount >= maxProjects) {
        return res.status(403).json({ error: `Maximum ${maxProjects} projects allowed for ${user.plan} plan` });
      }

      const project = await storage.createProject({
        name,
        description,
        ownerId: user.id,
        organizationId: user.organizationId,
      });

      res.json(project);
    } catch (error) {
      console.error("Error creating project:", error);
      res.status(500).json({ error: "Failed to create project" });
    }
  });

  app.get("/api/projects/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const project = await storage.getProject(parseInt(req.params.id));
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }
      if (project.ownerId !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Access denied" });
      }
      res.json(project);
    } catch (error) {
      console.error("Error fetching project:", error);
      res.status(500).json({ error: "Failed to fetch project" });
    }
  });

  app.patch("/api/projects/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const project = await storage.getProject(parseInt(id));

      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      if (project.ownerId !== user.id) {
        return res.status(403).json({ error: "Not authorized to update this project" });
      }

      const { name, description } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Name required" });
      }

      const updated = await storage.updateProject(parseInt(id), { name, description });
      res.json(updated);
    } catch (error) {
      console.error("Error updating project:", error);
      res.status(500).json({ error: "Failed to update project" });
    }
  });

  app.delete("/api/projects/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const project = await storage.getProject(parseInt(id));

      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      if (project.ownerId !== user.id) {
        return res.status(403).json({ error: "Not authorized to delete this project" });
      }

      // Check if project has workflows
      const workflowCount = await storage.countWorkflowsByProject(parseInt(id));
      if (workflowCount > 0) {
        return res.status(400).json({ error: `Cannot delete project with ${workflowCount} workflow(s). Delete workflows first.` });
      }

      await storage.deleteProject(parseInt(id));
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting project:", error);
      res.status(500).json({ error: "Failed to delete project" });
    }
  });

  // ==================== WORKFLOW ROUTES ====================

  app.get("/api/workflows", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const ownWorkflows = await storage.getWorkflowsByOwner(user.id);

      // Include org workflows if user is in an org
      let orgWorkflows: typeof ownWorkflows = [];
      if (user.organizationId) {
        const all = await storage.getWorkflowsByOrganization(user.organizationId);
        const ownIds = new Set(ownWorkflows.map(w => w.id));
        orgWorkflows = all.filter(w => !ownIds.has(w.id));
      }

      // Attach the server's own authorization decision so the client doesn't have
      // to re-derive it (and risk getting it wrong): canSchedule gates the
      // recurring-schedule UI, matching the schedule route's canScheduleWorkflow.
      const withPerms = (list: typeof ownWorkflows) =>
        list.map(w => ({ ...w, canSchedule: canScheduleWorkflow(user, w) }));

      if (req.query.includePublic === "true") {
        const publicWorkflows = await storage.getPublicWorkflows();
        const seenIds = new Set([...ownWorkflows, ...orgWorkflows].map(w => w.id));
        const merged = [...ownWorkflows, ...orgWorkflows, ...publicWorkflows.filter(w => !seenIds.has(w.id))];
        return res.json(withPerms(merged));
      }

      res.json(withPerms([...ownWorkflows, ...orgWorkflows]));
    } catch (error) {
      console.error("Error fetching workflows:", error);
      res.status(500).json({ error: "Failed to fetch workflows" });
    }
  });

  app.get("/api/workflows/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const workflow = await storage.getWorkflow(parseInt(req.params.id));
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }
      if (!canAccessResource(user, workflow)) {
        return res.status(403).json({ error: "Access denied" });
      }
      res.json(workflow);
    } catch (error) {
      console.error("Error fetching workflow:", error);
      res.status(500).json({ error: "Failed to fetch workflow" });
    }
  });

  app.post("/api/workflows", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { name, description, projectId, providerId, visibility, config, organizationId } = req.body;

      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: "Name required" });
      }
      const cleanName = String(name).trim();

      if (!providerId) {
        return res.status(400).json({ error: "Provider required" });
      }
      const provider = await storage.getProvider(providerId);
      if (!provider) {
        return res.status(404).json({ error: "Provider not found" });
      }

      if (config) {
        const v = validateWorkflowConfig(config);
        if (!v.valid) return res.status(400).json({ error: v.error });
      }

      if (visibility === "private" && user.plan === "basic") {
        return res.status(403).json({ error: "Premium plan required for private workflows" });
      }

      // Check workflow limits per project
      if (projectId) {
        const workflowCount = await storage.countWorkflowsByProject(projectId);
        const maxWorkflows = user.plan === "basic" ? 10 : 20;

        if (workflowCount >= maxWorkflows) {
          return res.status(403).json({ error: `Maximum ${maxWorkflows} workflows per project allowed for ${user.plan} plan` });
        }
      }

      // Validate org membership if org resource
      if (organizationId && user.organizationId !== organizationId) {
        return res.status(403).json({ error: "Not a member of this organization" });
      }

      const workflow = await storage.createWorkflow({
        name: cleanName,
        description,
        ownerId: user.id,
        projectId,
        providerId,
        organizationId: organizationId || null,
        visibility: visibility || "public",
        isMainline: false,
        config: config || {},
      });

      res.json(workflow);
    } catch (error) {
      console.error("Error creating workflow:", error);
      res.status(500).json({ error: "Failed to create workflow" });
    }
  });

  app.patch("/api/workflows/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const workflow = await storage.getWorkflow(parseInt(id));
      
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      // Editing is owner/org only — a system admin has no special power over
      // another user's workflow (deleting for moderation stays admin-capable).
      if (!isOwnerOrOrgManager(user, workflow)) {
        return res.status(403).json({ error: "Only the workflow's owner can edit it" });
      }

      const { name, description, visibility, config, projectId, providerId } = req.body;
      if (config) {
        const v = validateWorkflowConfig(config);
        if (!v.valid) return res.status(400).json({ error: v.error });
      }
      const updates: Record<string, unknown> = {};
      if (name && String(name).trim()) updates.name = String(name).trim();
      if (description !== undefined) updates.description = description;
      if (config) updates.config = config;
      if (providerId !== undefined) {
        const provider = await storage.getProvider(providerId);
        if (!provider) {
          return res.status(404).json({ error: "Provider not found" });
        }
        updates.providerId = providerId;
      }
      if (visibility) {
        if (visibility === "private" && user.plan === "basic") {
          return res.status(403).json({ error: "Premium plan required for private workflows" });
        }
        updates.visibility = visibility;
      }
      if (projectId !== undefined) {
        if (workflow.projectId) {
          return res.status(400).json({ error: "Workflow is already attached to a project and cannot be reassigned" });
        }
        const project = await storage.getProject(projectId);
        if (!project) {
          return res.status(404).json({ error: "Project not found" });
        }
        if (project.ownerId !== user.id && !user.isAdmin) {
          return res.status(403).json({ error: "Not authorized to attach to this project" });
        }
        updates.projectId = projectId;
      }

      const updated = await storage.updateWorkflow(parseInt(id), updates);
      res.json(updated);
    } catch (error) {
      console.error("Error updating workflow:", error);
      res.status(500).json({ error: "Failed to update workflow" });
    }
  });

  app.patch("/api/workflows/:id/mainline", requireAuth, requirePrincipal, async (req, res) => {
    try {
      const { id } = req.params;
      const { isMainline } = req.body;
      
      const workflow = await storage.getWorkflow(parseInt(id));
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      if (isMainline && workflow.visibility === "private") {
        return res.status(400).json({ error: "Mainline workflows must be public" });
      }

      const updated = await storage.updateWorkflow(parseInt(id), { 
        isMainline,
        visibility: isMainline ? "public" : workflow.visibility,
      });
      
      res.json(updated);
    } catch (error) {
      console.error("Error updating workflow mainline:", error);
      res.status(500).json({ error: "Failed to update workflow" });
    }
  });

  app.delete("/api/workflows/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const workflow = await storage.getWorkflow(parseInt(id));

      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      if (!canEditResource(user, workflow)) {
        return res.status(403).json({ error: "Not authorized to delete this workflow" });
      }

      await storage.deleteWorkflow(parseInt(id));
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting workflow:", error);
      res.status(500).json({ error: "Failed to delete workflow" });
    }
  });

  // Clone a public workflow
  app.post("/api/workflows/:id/clone", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const source = await storage.getWorkflow(parseInt(req.params.id));
      if (!source) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      if (source.visibility !== "public" && source.ownerId !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Can only clone public workflows" });
      }

      const cloned = await storage.createWorkflow({
        name: `Clone of ${source.name}`,
        description: source.description,
        ownerId: user.id,
        providerId: source.providerId,
        visibility: "public",
        isMainline: false,
        config: source.config || {},
      });

      res.json(cloned);
    } catch (error) {
      console.error("Error cloning workflow:", error);
      res.status(500).json({ error: "Failed to clone workflow" });
    }
  });

  // ==================== EVAL SET ROUTES ====================

  app.get("/api/eval-sets", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const ownSets = await storage.getEvalSetsByOwner(user.id);

      // Include org eval sets if user is in an org
      let orgSets: typeof ownSets = [];
      if (user.organizationId) {
        const all = await storage.getEvalSetsByOrganization(user.organizationId);
        const ownIds = new Set(ownSets.map(s => s.id));
        orgSets = all.filter(s => !ownIds.has(s.id));
      }

      if (req.query.includePublic === "true") {
        const publicSets = await storage.getPublicEvalSets();
        const seenIds = new Set([...ownSets, ...orgSets].map(s => s.id));
        const merged = [...ownSets, ...orgSets, ...publicSets.filter(s => !seenIds.has(s.id))];
        return res.json(merged);
      }

      res.json([...ownSets, ...orgSets]);
    } catch (error) {
      console.error("Error fetching eval sets:", error);
      res.status(500).json({ error: "Failed to fetch eval sets" });
    }
  });

  app.get("/api/eval-sets/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const evalSet = await storage.getEvalSet(parseInt(req.params.id));
      if (!evalSet) {
        return res.status(404).json({ error: "Eval set not found" });
      }
      if (!canAccessResource(user, evalSet)) {
        return res.status(403).json({ error: "Access denied" });
      }
      res.json(evalSet);
    } catch (error) {
      console.error("Error fetching eval set:", error);
      res.status(500).json({ error: "Failed to fetch eval set" });
    }
  });

  app.post("/api/eval-sets", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { name, description, visibility, config, organizationId } = req.body;

      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: "Name required" });
      }
      const cleanName = String(name).trim();

      if (config) {
        const v = validateEvalSetConfig(config);
        if (!v.valid) return res.status(400).json({ error: v.error });
      }

      if (visibility === "private" && user.plan === "basic") {
        return res.status(403).json({ error: "Premium plan required for private eval sets" });
      }

      if (organizationId && user.organizationId !== organizationId) {
        return res.status(403).json({ error: "Not a member of this organization" });
      }

      // `builtIn` is a server-only marker for seeded system templates — never
      // accept it from a create request, or a user could lock their own eval set
      // to admin-only editing.
      const createCfg: Record<string, unknown> = config && typeof config === "object" ? { ...config } : {};
      delete createCfg.builtIn;
      const evalSet = await storage.createEvalSet({
        name: cleanName,
        description,
        ownerId: user.id,
        organizationId: organizationId || null,
        visibility: visibility || "public",
        isMainline: false,
        config: createCfg,
      });

      res.json(evalSet);
    } catch (error) {
      console.error("Error creating eval set:", error);
      res.status(500).json({ error: "Failed to create eval set" });
    }
  });

  app.patch("/api/eval-sets/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const evalSet = await storage.getEvalSet(parseInt(id));

      if (!evalSet) {
        return res.status(404).json({ error: "Eval set not found" });
      }

      // Built-in eval sets are system templates — only admins may edit them
      // (everyone else clones). User-owned eval sets are owner/org only: a system
      // admin has no special power over another user's content.
      if ((evalSet.config as Record<string, unknown>)?.builtIn === true) {
        if (!user.isAdmin) {
          return res.status(403).json({ error: "Built-in eval sets cannot be edited. Use clone instead." });
        }
      } else if (!isOwnerOrOrgManager(user, evalSet)) {
        return res.status(403).json({ error: "Only the owner can edit this eval set" });
      }

      const { name, description, visibility, config } = req.body;
      if (config !== undefined && config !== null) {
        const v = validateEvalSetConfig(config);
        if (!v.valid) return res.status(400).json({ error: v.error });
      }
      const updates: Record<string, unknown> = {};
      if (name && String(name).trim()) updates.name = String(name).trim();
      if (description !== undefined) updates.description = description;
      if (config !== undefined) {
        // `builtIn` is a server-controlled marker (system templates), not client
        // input — preserve the record's existing value so a user can't promote
        // their eval set to a template (which would flip edit rights to admin).
        const cfg: Record<string, unknown> = config && typeof config === "object" ? { ...config } : {};
        if ((evalSet.config as Record<string, unknown>)?.builtIn === true) cfg.builtIn = true; else delete cfg.builtIn;
        updates.config = cfg;
      }
      if (visibility) {
        if (visibility === "private" && user.plan === "basic") {
          return res.status(403).json({ error: "Premium plan required for private eval sets" });
        }
        updates.visibility = visibility;
      }

      const updated = await storage.updateEvalSet(parseInt(id), updates);
      res.json(updated);
    } catch (error) {
      console.error("Error updating eval set:", error);
      res.status(500).json({ error: "Failed to update eval set" });
    }
  });

  app.patch("/api/eval-sets/:id/mainline", requireAuth, requirePrincipal, async (req, res) => {
    try {
      const { id } = req.params;
      const { isMainline } = req.body;
      
      const evalSet = await storage.getEvalSet(parseInt(id));
      if (!evalSet) {
        return res.status(404).json({ error: "Eval set not found" });
      }

      if (isMainline && evalSet.visibility === "private") {
        return res.status(400).json({ error: "Mainline eval sets must be public" });
      }

      const updated = await storage.updateEvalSet(parseInt(id), { 
        isMainline,
        visibility: isMainline ? "public" : evalSet.visibility,
      });
      
      res.json(updated);
    } catch (error) {
      console.error("Error updating eval set mainline:", error);
      res.status(500).json({ error: "Failed to update eval set" });
    }
  });

  // Clone a public eval set (with optional name/config overrides)
  app.post("/api/eval-sets/:id/clone", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const source = await storage.getEvalSet(parseInt(req.params.id));
      if (!source) {
        return res.status(404).json({ error: "Eval set not found" });
      }

      if (source.visibility !== "public" && source.ownerId !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Can only clone public eval sets" });
      }

      const { name, config } = req.body || {};

      if (config) {
        const v = validateEvalSetConfig(config);
        if (!v.valid) return res.status(400).json({ error: v.error });
      }

      // Strip builtIn flag from cloned config so clones are always editable
      const cloneConfig = { ...(config || source.config || {}) };
      delete (cloneConfig as Record<string, unknown>).builtIn;

      const cloned = await storage.createEvalSet({
        name: name || `Clone of ${source.name}`,
        description: source.description,
        ownerId: user.id,
        visibility: user.plan === "basic" ? "public" : "private",
        isMainline: false,
        config: cloneConfig,
      });

      res.json(cloned);
    } catch (error) {
      console.error("Error cloning eval set:", error);
      res.status(500).json({ error: "Failed to clone eval set" });
    }
  });

  // Delete eval set (owner or admin, blocked if jobs reference it)
  app.delete("/api/eval-sets/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const evalSet = await storage.getEvalSet(parseInt(req.params.id));
      if (!evalSet) return res.status(404).json({ error: "Eval set not found" });

      if (!canEditResource(user, evalSet)) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Jobs referencing this eval set survive its deletion (FK is SET NULL and each
      // job carries an immutable snapshot), so deletion is no longer blocked.
      await storage.deleteEvalSet(evalSet.id);
      res.json({ message: "Eval set deleted" });
    } catch (error) {
      console.error("Error deleting eval set:", error);
      res.status(500).json({ error: "Failed to delete eval set" });
    }
  });

  // ==================== EVAL SCHEDULE ROUTES ====================

  // List all schedules for current user
  app.get("/api/eval-schedules", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const schedules = user.isAdmin
        ? await storage.getAllEvalSchedulesWithWorkflow()
        : await storage.getEvalSchedulesWithWorkflow(user.id);
      // Server-computed UI flags + lifecycle status, so the client never offers an
      // action that would 403 and shows a consistent status badge:
      //  - canManage: owner-only run/resume (matches run-now/enable routes)
      //  - canExtend: owner OR org manager (matches the extend route)
      //  - status: inactive (expired) → paused (disabled) → active; expiringSoon
      //    is an active schedule within 14 days of expiry (amber warning).
      const now = Date.now();
      const SOON_MS = 14 * 24 * 60 * 60 * 1000;
      const withPerms = schedules.map(s => {
        const wfRef = { ownerId: s.workflowOwnerId, organizationId: s.workflowOrganizationId };
        const expired = s.expiresAt != null && new Date(s.expiresAt).getTime() <= now;
        const status = expired ? "inactive" : !s.isEnabled ? "paused" : "active";
        const expiringSoon = status === "active" && s.expiresAt != null && new Date(s.expiresAt).getTime() <= now + SOON_MS;
        return {
          ...s,
          canManage: canScheduleWorkflow(user, wfRef),
          canExtend: isOwnerOrOrgManager(user, wfRef),
          status,
          expiringSoon,
        };
      });
      res.json(withPerms);
    } catch (error) {
      console.error("Error fetching eval schedules:", error);
      res.status(500).json({ error: "Failed to fetch eval schedules" });
    }
  });

  // Get a specific schedule
  app.get("/api/eval-schedules/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const schedule = await storage.getEvalSchedule(parseInt(req.params.id));
      if (!schedule) {
        return res.status(404).json({ error: "Schedule not found" });
      }
      if (!canEditResource(user, schedule)) {
        return res.status(403).json({ error: "Access denied" });
      }
      res.json(schedule);
    } catch (error) {
      console.error("Error fetching eval schedule:", error);
      res.status(500).json({ error: "Failed to fetch eval schedule" });
    }
  });

  // Create a new schedule (one-time or recurring)
  app.post("/api/eval-schedules", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { name, workflowId, evalSetId, region, scheduleType, cronExpression, timezone, runAt, maxRuns, organizationId } = req.body;

      if (!name || !workflowId || !region) {
        return res.status(400).json({ error: "Name, workflowId, and region are required" });
      }

      if (!["na", "apac", "eu", "sa"].includes(region)) {
        return res.status(400).json({ error: "Invalid region. Must be na, apac, eu, or sa" });
      }

      // A recurring schedule runs the workflow repeatedly on the OWNER's bound
      // secrets, so scheduling is restricted to the workflow's owner/creator — a
      // system admin and org managers are NOT exempt, since that would spend the
      // owner's secrets. Applies to deferred one-time schedules here too; the
      // always-open path is the separate immediate /api/workflows/:id/run route.
      const workflow = await storage.getWorkflow(workflowId);
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }
      if (!canScheduleWorkflow(user, workflow)) {
        return res.status(403).json({ error: "Only the workflow owner can schedule recurring evaluations" });
      }

      // Verify eval set
      if (!evalSetId) {
        return res.status(400).json({ error: "Eval set required" });
      }
      const evalSet = await storage.getEvalSet(evalSetId);
      if (!evalSet) {
        return res.status(404).json({ error: "Eval set not found" });
      }
      if (!canAccessResource(user, evalSet)) {
        return res.status(403).json({ error: "Access denied to eval set" });
      }

      const type = scheduleType || "once";
      let nextRunAt: Date | null = null;

      if (type === "once") {
        // One-time schedule: run immediately or at specified time
        nextRunAt = runAt ? new Date(runAt) : new Date();
      } else if (type === "recurring") {
        // Recurring schedule: requires cron expression
        if (!cronExpression) {
          return res.status(400).json({ error: "cronExpression is required for recurring schedules" });
        }
        // Validate cron expression (basic check)
        const cronParts = cronExpression.trim().split(/\s+/);
        if (cronParts.length !== 5) {
          return res.status(400).json({ error: "Invalid cron expression. Must have 5 parts: minute hour day month weekday" });
        }
        // Calculate first run time
        nextRunAt = parseNextCronRun(cronExpression);
      }

      const schedule = await storage.createEvalSchedule({
        name,
        workflowId,
        evalSetId,
        region,
        scheduleType: type,
        cronExpression: cronExpression || null,
        timezone: timezone || "UTC",
        isEnabled: true,
        nextRunAt,
        expiresAt: new Date(Date.now() + SCHEDULE_TTL_MS), // 90-day lifecycle; owner can Extend
        maxRuns: maxRuns || null,
        createdBy: user.id,
        organizationId: organizationId || null,
      });

      res.json(schedule);
    } catch (error) {
      console.error("Error creating eval schedule:", error);
      res.status(500).json({ error: "Failed to create eval schedule" });
    }
  });

  // Update a schedule
  app.patch("/api/eval-schedules/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const scheduleId = parseInt(req.params.id);
      const schedule = await storage.getEvalSchedule(scheduleId);

      if (!schedule) {
        return res.status(404).json({ error: "Schedule not found" });
      }
      if (!canEditResource(user, schedule)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const { name, isEnabled, cronExpression, maxRuns, nextRunAt } = req.body;

      // Enabling, rescheduling, advancing nextRunAt, or changing the run cap all
      // affect how many times runs execute on the workflow OWNER's secrets, so
      // they need owner rights (a system admin isn't exempt). Gate on an ACTUAL
      // change, not mere presence — the Edit dialog resends cron/maxRuns even on a
      // name-only edit, and disable/rename must stay open to the schedule's
      // manager for cleanup.
      const wantsEnable = isEnabled === true && !schedule.isEnabled;
      const cronChanged = cronExpression !== undefined && cronExpression !== schedule.cronExpression;
      const capChanged = maxRuns !== undefined && (maxRuns ?? null) !== (schedule.maxRuns ?? null);
      const nextRunChanged = nextRunAt !== undefined; // an explicit override always advances the schedule
      if (wantsEnable || cronChanged || capChanged || nextRunChanged) {
        const wf = schedule.workflowId != null ? await storage.getWorkflow(schedule.workflowId) : undefined;
        if (!wf || !canScheduleWorkflow(user, wf)) {
          return res.status(403).json({ error: "Only the workflow owner can enable or reschedule this schedule" });
        }
      }

      const updates: Record<string, unknown> = {};

      if (name !== undefined) updates.name = name;
      if (isEnabled !== undefined) updates.isEnabled = isEnabled;
      if (maxRuns !== undefined) updates.maxRuns = maxRuns;

      // If enabling a disabled schedule, recalculate next run time
      if (isEnabled === true && !schedule.isEnabled) {
        if (schedule.scheduleType === "recurring" && schedule.cronExpression) {
          updates.nextRunAt = parseNextCronRun(schedule.cronExpression);
        } else if (schedule.scheduleType === "once") {
          updates.nextRunAt = new Date();
        }
      }

      // Update cron expression and recalculate next run
      if (cronExpression !== undefined && schedule.scheduleType === "recurring") {
        const cronParts = cronExpression.trim().split(/\s+/);
        if (cronParts.length !== 5) {
          return res.status(400).json({ error: "Invalid cron expression" });
        }
        updates.cronExpression = cronExpression;
        if (schedule.isEnabled || isEnabled === true) {
          updates.nextRunAt = parseNextCronRun(cronExpression);
        }
      }

      // Allow manual override of nextRunAt
      if (nextRunAt !== undefined) {
        updates.nextRunAt = nextRunAt ? new Date(nextRunAt) : null;
      }

      const updated = await storage.updateEvalSchedule(scheduleId, updates);
      res.json(updated);
    } catch (error) {
      console.error("Error updating eval schedule:", error);
      res.status(500).json({ error: "Failed to update eval schedule" });
    }
  });

  // Delete a schedule
  app.delete("/api/eval-schedules/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const scheduleId = parseInt(req.params.id);
      const schedule = await storage.getEvalSchedule(scheduleId);

      if (!schedule) {
        return res.status(404).json({ error: "Schedule not found" });
      }
      if (!canEditResource(user, schedule)) {
        return res.status(403).json({ error: "Access denied" });
      }

      await storage.deleteEvalSchedule(scheduleId);
      res.json({ message: "Schedule deleted" });
    } catch (error) {
      console.error("Error deleting eval schedule:", error);
      res.status(500).json({ error: "Failed to delete eval schedule" });
    }
  });

  // Run a schedule immediately (creates a job now, doesn't affect the schedule's timing)
  app.post("/api/eval-schedules/:id/run-now", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const scheduleId = parseInt(req.params.id);
      const schedule = await storage.getEvalSchedule(scheduleId);

      if (!schedule) {
        return res.status(404).json({ error: "Schedule not found" });
      }
      if (!canEditResource(user, schedule)) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Merge workflow + evalSet configs
      if (schedule.workflowId == null || schedule.evalSetId == null) {
        return res.status(404).json({ error: "Schedule references a deleted workflow or eval set" });
      }
      const workflow = await storage.getWorkflow(schedule.workflowId);
      if (!workflow) {
        return res.status(404).json({ error: "Schedule references a deleted workflow" });
      }
      // run-now fires a job on the workflow OWNER's secrets, so it needs the same
      // owner-only gate as scheduling — a system admin isn't exempt.
      if (!canScheduleWorkflow(user, workflow)) {
        return res.status(403).json({ error: "Only the workflow owner can run this schedule" });
      }
      const evalSet = await storage.getEvalSet(schedule.evalSetId);

      const provider = await storage.getProvider(workflow.providerId);
      const job = await storage.createEvalJob({
        scheduleId: schedule.id,
        triggerType: 1, // scheduled (run-now off an existing schedule)
        workflowId: schedule.workflowId,
        evalSetId: schedule.evalSetId,
        createdBy: user.id,
        region: schedule.region,
        config: mergeEvalConfig(workflow.config, evalSet?.config),
        snapshot: buildJobSnapshot(workflow, evalSet, provider, user.plan),
        status: "pending",
        priority: 0,
        retryCount: 0,
        maxRetries: 3,
      });

      res.json({ message: "Job created", job });
    } catch (error) {
      console.error("Error running schedule:", error);
      res.status(500).json({ error: "Failed to run schedule" });
    }
  });

  // Extend a schedule's 90-day lifecycle. Owner OR org manager of the workflow
  // (extending resumes/prolongs runs on the workflow's secrets). Re-activates an
  // already-expired schedule by pushing expiresAt back into the future.
  app.post("/api/eval-schedules/:id/extend", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const scheduleId = parseInt(req.params.id);
      const schedule = await storage.getEvalSchedule(scheduleId);
      if (!schedule) return res.status(404).json({ error: "Schedule not found" });

      const workflow = schedule.workflowId != null ? await storage.getWorkflow(schedule.workflowId) : undefined;
      if (!workflow || !isOwnerOrOrgManager(user, workflow)) {
        return res.status(403).json({ error: "Only the workflow's owner or org can extend this schedule" });
      }

      const scheduleUpdates: Record<string, unknown> = {
        expiresAt: new Date(Date.now() + SCHEDULE_TTL_MS),
      };
      // If a recurring schedule lapsed with a stale (past) nextRunAt, resume at the
      // next cron occurrence instead of firing an immediate catch-up run.
      if (
        schedule.scheduleType === "recurring" &&
        schedule.cronExpression &&
        (!schedule.nextRunAt || schedule.nextRunAt.getTime() <= Date.now())
      ) {
        scheduleUpdates.nextRunAt = parseNextCronRun(schedule.cronExpression);
      }
      const updated = await storage.updateEvalSchedule(scheduleId, scheduleUpdates);
      res.json(updated);
    } catch (error) {
      console.error("Error extending schedule:", error);
      res.status(500).json({ error: "Failed to extend schedule" });
    }
  });

  // ==================== SECRETS ROUTES ====================

  // List user's secrets (names + timestamps only, never values)
  app.get("/api/secrets", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const encrypted = isEncryptionConfigured();
      if (!encrypted) {
        return res.json({ encryptionConfigured: false, secrets: [] });
      }

      const userSecrets = await storage.getSecretsByUserId(user.id);
      res.json({
        encryptionConfigured: true,
        secrets: userSecrets.map(s => ({
          id: s.id,
          name: s.name,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      });
    } catch (error) {
      console.error("Error listing secrets:", error);
      res.status(500).json({ error: "Failed to list secrets" });
    }
  });

  // Create or update a secret (upsert by name)
  app.post("/api/secrets", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { name, value } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Secret name is required" });
      }
      if (!value || typeof value !== "string") {
        return res.status(400).json({ error: "Secret value is required" });
      }
      const trimmedName = name.trim();
      if (!SECRET_NAME_PATTERN.test(trimmedName)) {
        return res.status(400).json({ error: "Secret name must be uppercase letters, digits, and underscores (e.g., YOUR_EMAIL)" });
      }
      if (trimmedName.length > 256) {
        return res.status(400).json({ error: "Secret name too long (max 256 characters)" });
      }
      if (value.length > 10000) {
        return res.status(400).json({ error: "Secret value too large (max 10KB)" });
      }

      // Per-user limit: check if this is a new secret (not an upsert of existing)
      const existing = await storage.getSecretsByUserId(user.id);
      const isUpdate = existing.some(s => s.name === trimmedName);
      if (!isUpdate && existing.length >= 50) {
        return res.status(400).json({ error: "Maximum of 50 secrets per user" });
      }

      const encrypted = encryptValue(value);
      const secret = await storage.createOrUpdateSecret(user.id, trimmedName, encrypted);
      res.json({ id: secret.id, name: secret.name, createdAt: secret.createdAt, updatedAt: secret.updatedAt });
    } catch (error) {
      console.error("Error creating secret:", error);
      if (error instanceof Error && error.message.includes("CREDENTIAL_ENCRYPTION_KEY")) {
        return res.status(500).json({ error: "Server encryption not configured" });
      }
      res.status(500).json({ error: "Failed to create secret" });
    }
  });

  // Delete a secret by name
  app.delete("/api/secrets/:name", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const deleted = await storage.deleteSecret(user.id, req.params.name);
      if (!deleted) {
        return res.status(404).json({ error: "Secret not found" });
      }
      res.json({ message: "Secret deleted" });
    } catch (error) {
      console.error("Error deleting secret:", error);
      res.status(500).json({ error: "Failed to delete secret" });
    }
  });

  // ==================== ORG SECRETS ====================

  // List org secrets (all members see names, admins see full)
  app.get("/api/org-secrets", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || !user.organizationId) {
        return res.status(403).json({ error: "Organization membership required" });
      }
      const secrets = await storage.getOrgSecrets(user.organizationId);
      res.json(secrets.map(s => ({
        name: s.name,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })));
    } catch (error) {
      console.error("Error fetching org secrets:", error);
      res.status(500).json({ error: "Failed to fetch org secrets" });
    }
  });

  // Create/update org secret (admin/owner only)
  app.post("/api/org-secrets", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || !user.organizationId) {
        return res.status(403).json({ error: "Organization membership required" });
      }
      const { name, value } = req.body;
      if (!name || !value) {
        return res.status(400).json({ error: "Name and value are required" });
      }
      const trimmedName = name.trim();
      if (!SECRET_NAME_PATTERN.test(trimmedName)) {
        return res.status(400).json({ error: "Name must be uppercase letters, digits, and underscores (e.g., MY_SECRET)" });
      }
      if (trimmedName.length > 100) {
        return res.status(400).json({ error: "Name too long (max 100 characters)" });
      }
      if (value.length > 10000) {
        return res.status(400).json({ error: "Value too long (max 10000 characters)" });
      }
      if (!isEncryptionConfigured()) {
        return res.status(503).json({ error: "Encryption not configured on server" });
      }
      const encrypted = encryptValue(value);
      await storage.upsertOrgSecret(user.organizationId, trimmedName, encrypted, user.id);
      res.json({ message: "Org secret saved" });
    } catch (error) {
      console.error("Error saving org secret:", error);
      res.status(500).json({ error: "Failed to save org secret" });
    }
  });

  // Delete org secret (admin/owner only)
  app.delete("/api/org-secrets/:name", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || !user.organizationId) {
        return res.status(403).json({ error: "Organization membership required" });
      }
      await storage.deleteOrgSecret(user.organizationId, decodeURIComponent(req.params.name));
      res.json({ message: "Org secret deleted" });
    } catch (error) {
      console.error("Error deleting org secret:", error);
      res.status(500).json({ error: "Failed to delete org secret" });
    }
  });

  // ==================== EVAL AGENT TOKEN ROUTES (User-facing) ====================

  app.get("/api/eval-agent-tokens", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Admin sees all tokens, non-admin sees only their own
      const tokens = user.isAdmin
        ? await storage.getAllEvalAgentTokens()
        : await storage.getEvalAgentTokensByUser(user.id);

      res.json(tokens.map(t => ({
        id: t.id,
        name: t.name,
        region: t.region,
        visibility: t.visibility,
        isRevoked: t.isRevoked,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
        createdBy: t.createdBy,
      })));
    } catch (error) {
      console.error("Error fetching eval agent tokens:", error);
      res.status(500).json({ error: "Failed to fetch eval agent tokens" });
    }
  });

  app.post("/api/eval-agent-tokens", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Basic users cannot create tokens
      if (user.plan === "basic" && !user.isAdmin) {
        return res.status(403).json({ error: "Premium or higher plan required to create eval agent tokens" });
      }

      const { name, region, visibility } = req.body;

      if (!name || !region) {
        return res.status(400).json({ error: "Name and region required" });
      }

      if (!["na", "apac", "eu", "sa"].includes(region)) {
        return res.status(400).json({ error: "Invalid region. Must be na, apac, eu, or sa" });
      }

      // Non-admin users can only create private tokens
      const tokenVisibility = user.isAdmin ? (visibility || "public") : "private";

      if (tokenVisibility !== "public" && tokenVisibility !== "private") {
        return res.status(400).json({ error: "Invalid visibility. Must be public or private" });
      }

      const token = generateEvalAgentToken();
      const tokenHash = hashToken(token);

      const evalAgentToken = await storage.createEvalAgentToken({
        name,
        tokenHash,
        region,
        visibility: tokenVisibility,
        createdBy: user.id,
        isRevoked: false,
      });

      res.json({
        id: evalAgentToken.id,
        name: evalAgentToken.name,
        token,
        region: evalAgentToken.region,
        visibility: evalAgentToken.visibility,
        createdAt: evalAgentToken.createdAt,
      });
    } catch (error) {
      console.error("Error creating eval agent token:", error);
      res.status(500).json({ error: "Failed to create eval agent token" });
    }
  });

  app.post("/api/eval-agent-tokens/:id/revoke", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const token = await storage.getEvalAgentToken(parseInt(id));

      if (!token) {
        return res.status(404).json({ error: "Token not found" });
      }

      // Only owner or admin can revoke
      if (token.createdBy !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Not authorized to revoke this token" });
      }

      await storage.revokeEvalAgentToken(parseInt(id));
      res.json({ message: "Eval agent token revoked" });
    } catch (error) {
      console.error("Error revoking eval agent token:", error);
      res.status(500).json({ error: "Failed to revoke eval agent token" });
    }
  });

  // ==================== EVAL AGENT TOKEN ROUTES (Admin only) ====================

  app.get("/api/admin/eval-agent-tokens", requireAuth, requireAdmin, async (req, res) => {
    try {
      const tokens = await storage.getAllEvalAgentTokens();
      res.json(tokens.map(t => ({
        id: t.id,
        name: t.name,
        region: t.region,
        visibility: t.visibility,
        isRevoked: t.isRevoked,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
      })));
    } catch (error) {
      console.error("Error fetching eval agent tokens:", error);
      res.status(500).json({ error: "Failed to fetch eval agent tokens" });
    }
  });

  app.post("/api/admin/eval-agent-tokens", requireAuth, requireAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { name, region, visibility } = req.body;

      if (!name || !region) {
        return res.status(400).json({ error: "Name and region required" });
      }

      if (!["na", "apac", "eu", "sa"].includes(region)) {
        return res.status(400).json({ error: "Invalid region. Must be na, apac, eu, or sa" });
      }

      const tokenVisibility = visibility || "public";
      if (tokenVisibility !== "public" && tokenVisibility !== "private") {
        return res.status(400).json({ error: "Invalid visibility. Must be public or private" });
      }

      const token = generateEvalAgentToken();
      const tokenHash = hashToken(token);

      const evalAgentToken = await storage.createEvalAgentToken({
        name,
        tokenHash,
        region,
        visibility: tokenVisibility,
        createdBy: user.id,
        isRevoked: false,
      });

      res.json({
        id: evalAgentToken.id,
        name: evalAgentToken.name,
        token,
        region: evalAgentToken.region,
        visibility: evalAgentToken.visibility,
        createdAt: evalAgentToken.createdAt,
      });
    } catch (error) {
      console.error("Error creating eval agent token:", error);
      res.status(500).json({ error: "Failed to create eval agent token" });
    }
  });

  app.post("/api/admin/eval-agent-tokens/:id/revoke", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.revokeEvalAgentToken(parseInt(id));
      res.json({ message: "Eval agent token revoked" });
    } catch (error) {
      console.error("Error revoking eval agent token:", error);
      res.status(500).json({ error: "Failed to revoke eval agent token" });
    }
  });

  // ==================== EVAL AGENT ROUTES ====================

  app.get("/api/eval-agents", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      const agents = await storage.getEvalAgentsWithTokenVisibility();
      // Public agents visible to all; private agents only visible to their owner or admins
      const visible = agents.filter(a =>
        a.tokenVisibility === "public" ||
        (user && (user.id === a.tokenCreatedBy || user.isAdmin))
      );
      res.json(visible.map(a => ({
        id: a.id,
        name: a.name,
        region: a.region,
        state: a.state,
        metadata: a.metadata,
        lastSeenAt: a.lastSeenAt,
        lastJobAt: a.lastJobAt,
        createdAt: a.createdAt,
        visibility: a.tokenVisibility,
      })));
    } catch (error) {
      console.error("Error fetching eval agents:", error);
      res.status(500).json({ error: "Failed to fetch eval agents" });
    }
  });

  // A daemon that re-registered rotates the agent's lease; an older instance
  // (restart leftover or duplicate on the same token) is thus superseded. Once
  // an agent holds a lease, every state-changing call MUST carry the matching
  // lease — a missing or mismatched lease is fenced. (Requires all daemons to be
  // on the lease-aware build; deploy after `vox-upgrade.sh`.)
  const isSupersededLease = (agent: { currentLeaseId?: string | null }, leaseId: unknown): boolean =>
    !!agent.currentLeaseId && leaseId !== agent.currentLeaseId;

  // Authorize a job-scoped agent endpoint against the job's OWN assigned agent
  // (not the token's latest agent — token_id isn't unique, so duplicate rows
  // could otherwise validate the lease against the wrong agent). This both
  // prevents cross-job access (the job's agent must belong to this token) and
  // fences a superseded lease (must match the assigned agent's current lease).
  const authorizeJobAgent = async (jobId: number, tokenId: number, leaseId: unknown) => {
    const job = await storage.getEvalJob(jobId);
    if (!job) return { status: "notfound" as const };
    if (!job.evalAgentId) return { status: "unauthorized" as const };
    const agent = await storage.getEvalAgent(job.evalAgentId);
    if (!agent || agent.tokenId !== tokenId) return { status: "unauthorized" as const };
    if (isSupersededLease(agent, leaseId)) return { status: "superseded" as const };
    return { status: "ok" as const, job, agent };
  };

  // Map an authorizeJobAgent result to an HTTP response; returns true if it
  // handled (sent) an error, false if authorized (caller proceeds).
  const denyJobAgent = (res: { status: (c: number) => { json: (b: unknown) => void } }, auth: { status: string }): boolean => {
    if (auth.status === "notfound") { res.status(404).json({ error: "Job not found" }); return true; }
    if (auth.status === "unauthorized") { res.status(403).json({ error: "Job not assigned to your agent" }); return true; }
    if (auth.status === "superseded") { res.status(403).json({ error: "superseded", superseded: true }); return true; }
    return false;
  };

  // Eval agent registration endpoint (uses eval agent token for auth)
  app.post("/api/eval-agent/register", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Eval agent token required" });
      }

      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);
      const evalAgentToken = await storage.getEvalAgentTokenByHash(tokenHash);
      
      if (!evalAgentToken) {
        return res.status(401).json({ error: "Invalid eval agent token" });
      }

      if (evalAgentToken.isRevoked) {
        return res.status(403).json({ error: "Eval agent token has been revoked" });
      }

      if (evalAgentToken.expiresAt && new Date() > new Date(evalAgentToken.expiresAt)) {
        return res.status(403).json({ error: "Eval agent token has expired" });
      }

      const { name, metadata } = req.body;

      // Use agent-provided name, or fall back to the token's name
      const agentName = name || evalAgentToken.name;

      await storage.updateEvalAgentTokenLastUsed(evalAgentToken.id);

      // Issue a fresh per-process lease. Only this lease may act as the agent;
      // any earlier instance is fenced on its next heartbeat/claim/complete.
      const leaseId = generateSecureToken(16);

      // Upsert: reuse existing agent row for this token instead of creating duplicates on restart
      const existing = await storage.getEvalAgentsByTokenId(evalAgentToken.id);
      let agent;
      if (existing.length > 0) {
        agent = existing[0];
        await storage.updateEvalAgent(agent.id, { name: agentName, state: "idle", metadata: metadata || {}, currentLeaseId: leaseId });
        agent = { ...agent, name: agentName, state: "idle" as const, metadata: metadata || {}, currentLeaseId: leaseId };
        // A fresh registration means the prior process died; release any jobs it
        // was still running so they re-queue instead of hanging as "running"
        // forever (the heartbeat reaper misses them — this agent looks alive).
        const released = await storage.releaseAgentRunningJobs(agent.id);
        if (released > 0) {
          console.log(`[eval-agent] Released ${released} orphaned running job(s) from re-registered agent ${agent.id}`);
        }
      } else {
        agent = await storage.createEvalAgent({
          name: agentName,
          tokenId: evalAgentToken.id,
          region: evalAgentToken.region,
          state: "idle",
          metadata: metadata || {},
          currentLeaseId: leaseId,
        });
      }

      await storage.updateEvalAgentHeartbeat(agent.id);

      res.json({
        id: agent.id,
        name: agent.name,
        region: agent.region,
        state: agent.state,
        leaseId,
      });
    } catch (error) {
      console.error("Error registering eval agent:", error);
      res.status(500).json({ error: "Failed to register eval agent" });
    }
  });

  // Eval agent heartbeat endpoint
  app.post("/api/eval-agent/heartbeat", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Eval agent token required" });
      }

      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);
      const evalAgentToken = await storage.getEvalAgentTokenByHash(tokenHash);
      
      if (!evalAgentToken || evalAgentToken.isRevoked) {
        return res.status(401).json({ error: "Invalid or revoked eval agent token" });
      }

      const { agentId, state, metadata, leaseId } = req.body;

      if (!agentId) {
        return res.status(400).json({ error: "Agent ID required" });
      }

      const agent = await storage.getEvalAgent(agentId);
      if (!agent || agent.tokenId !== evalAgentToken.id) {
        return res.status(403).json({ error: "Agent not found or token mismatch" });
      }
      if (isSupersededLease(agent, leaseId)) {
        return res.status(403).json({ error: "superseded", superseded: true });
      }

      await storage.updateEvalAgentHeartbeat(agentId);

      const updates: Record<string, unknown> = {};
      if (state && ["idle", "offline", "occupied"].includes(state)) {
        updates.state = state;
      }
      if (metadata && typeof metadata === "object") {
        updates.metadata = metadata;
      }
      if (Object.keys(updates).length > 0) {
        await storage.updateEvalAgent(agentId, updates);
      }

      res.json({ message: "Heartbeat received" });
    } catch (error) {
      console.error("Error processing heartbeat:", error);
      res.status(500).json({ error: "Failed to process heartbeat" });
    }
  });

  // ==================== EVAL JOB ROUTES ====================

  // Get pending jobs for an eval agent's region
  app.get("/api/eval-agent/jobs", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Eval agent token required" });
      }

      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);
      const evalAgentToken = await storage.getEvalAgentTokenByHash(tokenHash);
      
      if (!evalAgentToken || evalAgentToken.isRevoked) {
        return res.status(401).json({ error: "Invalid or revoked eval agent token" });
      }

      let jobs = await storage.getPendingEvalJobsByRegion(evalAgentToken.region);

      // Version-gate: if the requesting agent has a frameworkVersion, filter out
      // jobs whose config requires a newer version than the agent supports.
      const agents = await storage.getEvalAgentsByTokenId(evalAgentToken.id);
      const latestAgent = agents[0]; // sorted by createdAt desc
      const agentVersion = (latestAgent?.metadata as Record<string, unknown>)?.frameworkVersion as string | undefined;

      if (agentVersion) {
        jobs = jobs.filter((job) => {
          const jobVersion = (job.config as Record<string, unknown>)?.frameworkVersion as string | undefined;
          if (!jobVersion) return true; // jobs without version pass through
          return compareVersions(jobVersion, agentVersion) <= 0;
        });
      }

      res.json(jobs);
    } catch (error) {
      console.error("Error fetching jobs:", error);
      res.status(500).json({ error: "Failed to fetch jobs" });
    }
  });

  // Claim a job
  app.post("/api/eval-agent/jobs/:jobId/claim", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Eval agent token required" });
      }

      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);
      const evalAgentToken = await storage.getEvalAgentTokenByHash(tokenHash);
      
      if (!evalAgentToken || evalAgentToken.isRevoked) {
        return res.status(401).json({ error: "Invalid or revoked eval agent token" });
      }

      const { jobId } = req.params;
      const { agentId, leaseId } = req.body;

      if (!agentId) {
        return res.status(400).json({ error: "Agent ID required" });
      }

      const agent = await storage.getEvalAgent(agentId);
      if (!agent || agent.tokenId !== evalAgentToken.id) {
        return res.status(403).json({ error: "Agent not found or token mismatch" });
      }
      if (isSupersededLease(agent, leaseId)) {
        return res.status(403).json({ error: "superseded", superseded: true });
      }

      // Check that job's region matches agent's region
      const existingJob = await storage.getEvalJob(parseInt(jobId));
      if (!existingJob) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (existingJob.region !== agent.region) {
        return res.status(403).json({ error: "Job region does not match agent region" });
      }

      // Freeze the claiming agent's token visibility onto the job in the SAME atomic
      // claim update — the one tier input not known at creation. Completes the
      // immutable metric-tier snapshot (no separate write to lose on a crash).
      const job = await storage.claimEvalJob(parseInt(jobId), agentId, evalAgentToken.visibility);
      if (!job) {
        return res.status(409).json({ error: "Job already claimed or not found" });
      }

      await storage.updateEvalAgent(agentId, { state: "occupied", lastJobAt: new Date() });

      res.json(job);
    } catch (error) {
      console.error("Error claiming job:", error);
      res.status(500).json({ error: "Failed to claim job" });
    }
  });

  // Complete a job and submit results
  app.post("/api/eval-agent/jobs/:jobId/complete", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Eval agent token required" });
      }

      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);
      const evalAgentToken = await storage.getEvalAgentTokenByHash(tokenHash);
      
      if (!evalAgentToken || evalAgentToken.isRevoked) {
        return res.status(401).json({ error: "Invalid or revoked eval agent token" });
      }

      const { jobId } = req.params;
      const { agentId, error: jobError, results, leaseId } = req.body;

      if (!agentId) {
        return res.status(400).json({ error: "Agent ID required" });
      }

      const agent = await storage.getEvalAgent(agentId);
      if (!agent || agent.tokenId !== evalAgentToken.id) {
        return res.status(403).json({ error: "Agent not found or token mismatch" });
      }
      // Fence a superseded instance so it can't write stale results for a job
      // that was already re-queued to the current lease holder.
      if (isSupersededLease(agent, leaseId)) {
        return res.status(403).json({ error: "superseded", superseded: true });
      }

      const job = await storage.getEvalJob(parseInt(jobId));
      if (!job || job.evalAgentId !== agentId) {
        return res.status(403).json({ error: "Job not found or not assigned to this agent" });
      }

      await storage.updateEvalAgent(agentId, { state: "idle" });

      if (results) {
        // Attribute the result to the provider snapshotted on the job at creation —
        // not the live workflow, which may have been re-pointed since. Fall back to a
        // default provider only for legacy jobs with no snapshot.
        let providerId = job.snapshot?.provider?.id;
        if (!providerId) {
          const providers = await storage.getAllProviders();
          const defaultProvider = providers.find(p => p.name.includes("LiveKit")) || providers[0];
          providerId = defaultProvider?.id;
        }

        if (providerId) {
          try {
            await storage.createEvalResult({
              evalJobId: parseInt(jobId),
              providerId,
              region: job.region,
              responseLatencyMedian: results.responseLatencyMedian || 0,
              responseLatencySd: results.responseLatencySd || 0,
              responseLatencyP95: results.responseLatencyP95 || 0,
              interruptLatencyMedian: results.interruptLatencyMedian || 0,
              interruptLatencySd: results.interruptLatencySd || 0,
              interruptLatencyP95: results.interruptLatencyP95 || 0,
              responseRate: results.responseRate ?? null,
              interruptRate: results.interruptRate ?? null,
              falseInterruptRate: results.falseInterruptRate ?? null,
              networkResilience: results.networkResilience,
              naturalness: results.naturalness,
              noiseReduction: results.noiseReduction,
              rawData: results.rawData || {},
            });
          } catch (resultError) {
            console.error(`Failed to create eval result for job ${jobId}:`, resultError);
            // Mark job as failed since results couldn't be saved
            await storage.completeEvalJob(parseInt(jobId), "Failed to save eval results");
            return res.status(500).json({ error: "Failed to save eval results" });
          }
        } else {
          console.warn(`No provider found for job ${jobId}, skipping eval result creation`);
        }
      }

      // Mark job as completed (or failed if jobError was provided)
      await storage.completeEvalJob(parseInt(jobId), jobError);
      res.json({ message: "Job completed" });
    } catch (error) {
      console.error("Error completing job:", error);
      res.status(500).json({ error: "Failed to complete job" });
    }
  });

  // Store artifact URLs for a completed job (eval agent Bearer auth)
  app.post("/api/eval-agent/jobs/:jobId/artifacts", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Eval agent token required" });
      }

      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);
      const evalAgentToken = await storage.getEvalAgentTokenByHash(tokenHash);

      if (!evalAgentToken || evalAgentToken.isRevoked) {
        return res.status(401).json({ error: "Invalid or revoked token" });
      }

      const jobId = parseInt(req.params.jobId);
      const { zipUrl, files, leaseId } = req.body;

      // Only the agent that ran this job (matching lease) may store its artifacts.
      const auth = await authorizeJobAgent(jobId, evalAgentToken.id, leaseId);
      if (auth.status !== "ok") { denyJobAgent(res, auth); return; }

      if (!zipUrl) {
        return res.status(400).json({ error: "zipUrl is required" });
      }

      // Ensure an eval result row exists (failed jobs may not have one)
      const existing = await storage.getEvalResultsByJob(jobId);
      if (existing.length === 0) {
        const job = await storage.getEvalJob(jobId);
        if (job) {
          // Attribute to the snapshotted provider (immutable), not the live workflow.
          const providers = await storage.getAllProviders();
          const providerId = job.snapshot?.provider?.id || providers[0]?.id;
          if (providerId) {
            await storage.createEvalResult({
              evalJobId: jobId,
              providerId,
              region: job.region,
              responseLatencyMedian: 0,
              responseLatencySd: 0,
              responseLatencyP95: 0,
              interruptLatencyMedian: 0,
              interruptLatencySd: 0,
              interruptLatencyP95: 0,
              artifactStatus: 'uploaded',
            });
          }
        }
      }

      await storage.updateEvalResultArtifacts(jobId, zipUrl, files || []);
      res.json({ message: "Artifacts stored" });
    } catch (error) {
      console.error("Error storing artifacts:", error);
      res.status(500).json({ error: "Failed to store artifacts" });
    }
  });

  // Update artifact upload status (eval agent Bearer auth)
  app.patch("/api/eval-agent/jobs/:jobId/artifact-status", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Eval agent token required" });
      }

      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);
      const evalAgentToken = await storage.getEvalAgentTokenByHash(tokenHash);

      if (!evalAgentToken || evalAgentToken.isRevoked) {
        return res.status(401).json({ error: "Invalid or revoked token" });
      }

      const jobId = parseInt(req.params.jobId);
      const { status, leaseId } = req.body;

      // Only the agent that ran this job (matching lease) may change its status.
      const auth = await authorizeJobAgent(jobId, evalAgentToken.id, leaseId);
      if (auth.status !== "ok") { denyJobAgent(res, auth); return; }

      if (!status || !['pending', 'uploading', 'uploaded', 'failed'].includes(status)) {
        return res.status(400).json({ error: "Invalid status. Must be: pending, uploading, uploaded, failed" });
      }

      await storage.updateEvalResultArtifactStatus(jobId, status);
      res.json({ message: "Status updated" });
    } catch (error) {
      console.error("Error updating artifact status:", error);
      res.status(500).json({ error: "Failed to update artifact status" });
    }
  });

  // Reset stuck uploading artifacts to failed (eval agent Bearer auth, called on startup)
  app.post("/api/eval-agent/artifacts/reset-stuck", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Eval agent token required" });
      }

      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);
      const evalAgentToken = await storage.getEvalAgentTokenByHash(tokenHash);

      if (!evalAgentToken || evalAgentToken.isRevoked) {
        return res.status(401).json({ error: "Invalid or revoked token" });
      }

      // Strict: require a current leased agent for this token and a matching
      // lease — a token with no registered agent can't reset uploads either.
      const currentAgent = (await storage.getEvalAgentsByTokenId(evalAgentToken.id))[0];
      if (!currentAgent || isSupersededLease(currentAgent, req.body?.leaseId)) {
        return res.status(403).json({ error: "superseded", superseded: true });
      }

      const count = await storage.resetStuckArtifactUploads();
      if (count > 0) {
        console.log(`[Artifacts] Reset ${count} stuck uploading artifact(s) to failed`);
      }
      res.json({ message: "OK", reset: count });
    } catch (error) {
      console.error("Error resetting stuck artifacts:", error);
      res.status(500).json({ error: "Failed to reset" });
    }
  });

  // Get S3 storage config for a job (eval agent Bearer auth)
  // Returns per-user config if available, otherwise system defaults
  app.get("/api/eval-agent/jobs/:jobId/storage-config", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Eval agent token required" });
      }

      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);
      const evalAgentToken = await storage.getEvalAgentTokenByHash(tokenHash);

      if (!evalAgentToken || evalAgentToken.isRevoked) {
        return res.status(401).json({ error: "Invalid or revoked token" });
      }

      // Authorize against the job's assigned agent + fence a superseded lease
      // before returning any storage credentials.
      const auth = await authorizeJobAgent(parseInt(req.params.jobId), evalAgentToken.id, req.query.leaseId);
      if (auth.status !== "ok") { denyJobAgent(res, auth); return; }
      const { job } = auth;

      // Check if job creator has custom storage config
      if (job.createdBy) {
        const userConfig = await storage.getUserStorageConfig(job.createdBy);
        if (userConfig) {
          return res.json({
            source: "user",
            s3Endpoint: userConfig.s3Endpoint,
            s3Bucket: userConfig.s3Bucket,
            s3Region: userConfig.s3Region,
            s3AccessKeyId: decryptValue(userConfig.s3AccessKeyId),
            s3SecretAccessKey: decryptValue(userConfig.s3SecretAccessKey),
          });
        }
      }

      // Fall back to system defaults (env vars on daemon side)
      res.json({ source: "system" });
    } catch (error) {
      console.error("Error getting storage config:", error);
      res.status(500).json({ error: "Failed to get storage config" });
    }
  });

  // Get decrypted secrets for a claimed job (eval agent Bearer auth)
  app.get("/api/eval-agent/jobs/:jobId/secrets", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Eval agent token required" });
      }

      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);
      const evalAgentToken = await storage.getEvalAgentTokenByHash(tokenHash);

      if (!evalAgentToken || evalAgentToken.isRevoked) {
        return res.status(401).json({ error: "Invalid or revoked eval agent token" });
      }

      const { jobId } = req.params;
      // Authorize against the job's assigned agent + fence a superseded lease
      // before returning any decrypted secrets.
      const auth = await authorizeJobAgent(parseInt(jobId), evalAgentToken.id, req.query.leaseId);
      if (auth.status !== "ok") { denyJobAgent(res, auth); return; }

      // Only allow secrets access for actively running jobs
      if (auth.job.status !== "running") {
        return res.status(403).json({ error: "Secrets only available for running jobs" });
      }

      // Secrets follow ownership of the workflow: an ORG-owned workflow spends the
      // ORG's secrets (so org co-workers can run it without touching anyone's
      // personal key); a PERSONAL workflow spends its owner's personal secrets.
      // This is what makes org-member run/extend safe — they never spend an
      // individual's personal credentials.
      const decrypted: Record<string, string> = {};
      const jobWorkflow = auth.job.workflowId != null ? await storage.getWorkflow(auth.job.workflowId) : undefined;

      if (jobWorkflow?.organizationId) {
        // Org workflow → org secrets only. getOrgSecretsForJob fences by the job
        // creator's org membership, so a non-member running a *public* org
        // workflow deliberately gets no secrets (never leak org creds to
        // outsiders) — such a run simply fails at execution if it needs them.
        const orgSecrets = await storage.getOrgSecretsForJob(parseInt(jobId));
        Object.assign(decrypted, orgSecrets);
        console.log(`[Secrets] Job ${jobId}: org workflow → ${Object.keys(orgSecrets).length} org secret(s)`);
      } else {
        // Personal workflow → the owner's personal secrets.
        const userSecrets = await storage.getSecretsForJob(parseInt(jobId));
        for (const s of userSecrets) {
          try {
            decrypted[s.name] = decryptValue(s.encryptedValue);
          } catch (err) {
            console.error(`[Secrets] Failed to decrypt secret ${s.name} for job ${jobId}:`, err instanceof Error ? err.message : err);
          }
        }
        console.log(`[Secrets] Job ${jobId}: personal workflow → ${userSecrets.length} personal secret(s)`);
      }

      res.json(decrypted);
    } catch (error) {
      console.error("Error fetching job secrets:", error);
      if (error instanceof Error && error.message.includes("CREDENTIAL_ENCRYPTION_KEY")) {
        return res.status(500).json({ error: "Server encryption not configured" });
      }
      res.status(500).json({ error: "Failed to fetch secrets" });
    }
  });

  // Create eval jobs from workflow (triggered by user)
  app.post("/api/workflows/:workflowId/run", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { workflowId } = req.params;
      const { region, evalSetId } = req.body;
      
      const workflow = await storage.getWorkflow(parseInt(workflowId));
      
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      // Public workflows can be run by anyone; a private workflow only by its
      // owner or, for an org workflow, its org managers (no admin / principal-
      // fellow bypass — see canRunWorkflow).
      if (!canRunWorkflow(user, workflow)) {
        return res.status(403).json({ error: "Not authorized to run this workflow" });
      }

      // Daily job limit for basic users
      if (user.plan === "basic") {
        const todayCount = await storage.countTodayJobsByOwner(user.id);
        if (todayCount >= 80) {
          return res.status(429).json({ error: "Daily limit of 80 eval jobs reached. Upgrade to Premium for unlimited runs." });
        }
      }

      if (!region || !["na", "apac", "eu", "sa"].includes(region)) {
        return res.status(400).json({ error: "Valid region required (na, apac, eu, sa)" });
      }

      if (!evalSetId) {
        return res.status(400).json({ error: "Eval set required" });
      }
      const evalSet = await storage.getEvalSet(evalSetId);
      if (!evalSet) {
        return res.status(404).json({ error: "Eval set not found" });
      }
      // Same access level as the schedule route: you must be able to see the eval
      // set to run against it (blocks running against someone else's private set).
      if (!canAccessResource(user, evalSet)) {
        return res.status(403).json({ error: "Access denied to eval set" });
      }

      const provider = await storage.getProvider(workflow.providerId);
      const job = await storage.createEvalJob({
        workflowId: parseInt(workflowId),
        triggerType: 2, // manual (Run Workflow)
        evalSetId,
        createdBy: user.id,
        region,
        config: mergeEvalConfig(workflow.config, evalSet.config),
        snapshot: buildJobSnapshot(workflow, evalSet, provider, user.plan),
        status: "pending",
        priority: 0,
        retryCount: 0,
        maxRetries: 3,
      });

      res.json({
        message: "Job created",
        job,
      });
    } catch (error) {
      console.error("Error running workflow:", error);
      res.status(500).json({ error: "Failed to run workflow" });
    }
  });

  // ==================== EVAL JOB MANAGEMENT ROUTES ====================

  // List eval jobs with filters
  app.get("/api/eval-jobs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { status, region, workflowId, limit, offset, hours } = req.query;

      const pageLimit = Math.min(Math.max(parseInt(limit as string) || 50, 1), 200);
      const pageOffset = Math.max(parseInt(offset as string) || 0, 0);

      const filters: {
        status?: "pending" | "running" | "completed" | "failed";
        region?: "na" | "apac" | "eu" | "sa";
        workflowId?: number;
        hoursBack?: number;
      } = {};

      if (status && ["pending", "running", "completed", "failed"].includes(status as string)) {
        filters.status = status as "pending" | "running" | "completed" | "failed";
      }
      if (region && ["na", "apac", "eu", "sa"].includes(region as string)) {
        filters.region = region as "na" | "apac" | "eu" | "sa";
      }
      if (workflowId) {
        const parsed = parseInt(workflowId as string, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          filters.workflowId = parsed;
        }
      }
      if (hours) {
        const parsed = parseInt(hours as string, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return res.status(400).json({ error: "hours must be a positive integer" });
        }
        filters.hoursBack = parsed;
      }

      const jobs = await storage.getEvalJobs(filters);

      // For non-admin users, only return jobs for workflows they own or are public.
      // While the workflow exists, use its LIVE visibility (so a since-privatised
      // workflow's jobs aren't exposed via the frozen snapshot). Once the workflow is
      // deleted, only the owner may see the job — run-time visibility does not grant
      // ongoing public access.
      let visibleJobs = jobs;
      if (!user.isAdmin) {
        const userWorkflows = await storage.getWorkflowsByOwner(user.id);
        const publicWorkflows = await storage.getPublicWorkflows();
        const allowedIds = new Set([
          ...userWorkflows.map(w => w.id),
          ...publicWorkflows.map(w => w.id),
        ]);
        visibleJobs = jobs.filter(job => {
          if (job.workflowId != null) return allowedIds.has(job.workflowId);
          return job.createdBy === user.id; // deleted workflow: the runner sees their own job
        });
      }

      const total = visibleJobs.length;
      const paged = visibleJobs.slice(pageOffset, pageOffset + pageLimit);

      // Enrich with creator username
      const creatorIds = Array.from(new Set(paged.map(j => j.createdBy).filter((id): id is number => id != null)));
      const creatorMap = new Map<number, string>();
      for (const id of creatorIds) {
        const u = await storage.getUser(id);
        if (u) creatorMap.set(id, u.username);
      }

      const enriched = paged.map(job => ({
        ...job,
        creatorName: job.createdBy ? creatorMap.get(job.createdBy) || null : null,
        // trigger_type: 1 = scheduled, 2 = manual (recorded at creation). Fall back
        // to scheduleId for rows created before the column existed.
        type: job.triggerType === 1 ? "scheduled"
          : job.triggerType === 2 ? "manual"
          : job.scheduleId ? "scheduled" : "manual",
      }));

      res.json({ data: enriched, total });
    } catch (error) {
      console.error("Error fetching eval jobs:", error);
      res.status(500).json({ error: "Failed to fetch eval jobs" });
    }
  });

  // Get single eval job
  app.get("/api/eval-jobs/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const job = await storage.getEvalJob(parseInt(id));

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check authorization: owner, admin, or public workflow. Live check while the
      // workflow exists; once deleted, only the owner may view it.
      if (!user.isAdmin) {
        const workflow = job.workflowId != null ? await storage.getWorkflow(job.workflowId) : undefined;
        const allowed = workflow
          ? canAccessResource(user, workflow)
          : job.createdBy === user.id; // deleted workflow: runner only
        if (!allowed) {
          return res.status(403).json({ error: "Not authorized to view this job" });
        }
      }

      res.json(job);
    } catch (error) {
      console.error("Error fetching eval job:", error);
      res.status(500).json({ error: "Failed to fetch eval job" });
    }
  });

  // Get job detail with eval results and artifacts
  app.get("/api/eval-jobs/:id/detail", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const jobId = parseInt(req.params.id);
      const job = await storage.getEvalJob(jobId);

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check authorization: owner, admin, or public workflow. When the workflow
      // still exists, use its LIVE visibility; once deleted, only the owner may view
      // it (run-time visibility does not confer ongoing public read access).
      if (!user.isAdmin) {
        const workflow = job.workflowId != null ? await storage.getWorkflow(job.workflowId) : undefined;
        if (workflow) {
          if (!canAccessResource(user, workflow)) {
            return res.status(403).json({ error: "Not authorized to view this job" });
          }
        } else if (job.createdBy !== user.id) {
          // Deleted workflow: only the runner may view their own job.
          return res.status(403).json({ error: "Not authorized to view this job" });
        }
      }

      // Get eval results for this job
      const results = await storage.getEvalResultsByJob(jobId);
      const result = results[0] ?? null;

      // Get creator name
      const creator = job.createdBy ? await storage.getUser(job.createdBy) : null;

      // Sign artifact URLs if available
      let signedArtifactUrl: string | null = null;
      let signedFiles: Array<{ name: string; url: string; size: number; contentType: string }> = [];

      if (result?.artifactUrl || (result?.artifactFiles as unknown[])?.length) {
        const ownerId = job.createdBy ?? user.id;

        if (result.artifactUrl) {
          signedArtifactUrl = await generateSignedUrlForUser(ownerId, result.artifactUrl as string);
        }

        const files = (result.artifactFiles ?? []) as Array<{ name: string; url: string; size: number; contentType: string }>;
        signedFiles = await Promise.all(
          files.map(async (f) => ({
            ...f,
            url: (await generateSignedUrlForUser(ownerId, f.url)) ?? f.url,
          }))
        );
      }

      res.json({
        job,
        result: result ? {
          ...result,
          artifactUrl: signedArtifactUrl,
          artifactFiles: signedFiles.length > 0 ? signedFiles : result.artifactFiles,
        } : null,
        workflowName: job.snapshot?.workflow?.name ?? `Workflow #${job.workflowId ?? "?"}`,
        creatorName: creator?.username ?? null,
      });
    } catch (error) {
      console.error("Error fetching job detail:", error);
      res.status(500).json({ error: "Failed to fetch job detail" });
    }
  });

  // Request re-upload of artifacts for a failed job (creator or admin only)
  app.post("/api/eval-jobs/:id/reupload", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const jobId = parseInt(req.params.id);
      const job = await storage.getEvalJob(jobId);
      if (!job) return res.status(404).json({ error: "Job not found" });

      // Authorization: job creator, schedule creator, or admin
      let authorized = user.isAdmin || job.createdBy === user.id;
      if (!authorized && job.scheduleId) {
        const schedule = await storage.getEvalSchedule(job.scheduleId);
        if (schedule && schedule.createdBy === user.id) authorized = true;
      }
      if (!authorized) return res.status(403).json({ error: "Not authorized" });

      // Only allow re-upload of failed artifacts
      const results = await storage.getEvalResultsByJob(jobId);
      const result = results[0];
      if (!result) return res.status(404).json({ error: "No result found for this job" });
      if (result.artifactStatus === 'uploaded') return res.status(400).json({ error: "Artifacts already uploaded" });
      if (result.artifactStatus === 'uploading') return res.status(409).json({ error: "Upload already in progress" });
      if (result.artifactStatus === 'pending') return res.status(409).json({ error: "Upload already pending" });

      await storage.updateEvalResultArtifactStatus(jobId, 'pending');
      res.json({ message: "Re-upload queued. The eval agent will retry on its next idle cycle." });
    } catch (error) {
      console.error("Error requesting re-upload:", error);
      res.status(500).json({ error: "Failed to request re-upload" });
    }
  });

  // Cancel a pending job
  app.delete("/api/eval-jobs/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const job = await storage.getEvalJob(parseInt(id));

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check authorization (owner). Deleted workflow → the runner (createdBy).
      if (!user.isAdmin) {
        const workflow = job.workflowId != null ? await storage.getWorkflow(job.workflowId) : undefined;
        const allowed = workflow ? workflow.ownerId === user.id : job.createdBy === user.id;
        if (!allowed) {
          return res.status(403).json({ error: "Not authorized to cancel this job" });
        }
      }

      if (job.status !== "pending") {
        return res.status(400).json({ error: "Can only cancel pending jobs" });
      }

      const cancelledJob = await storage.cancelEvalJob(parseInt(id));
      if (!cancelledJob) {
        return res.status(400).json({ error: "Failed to cancel job" });
      }

      res.json({ message: "Job cancelled", job: cancelledJob });
    } catch (error) {
      console.error("Error cancelling eval job:", error);
      res.status(500).json({ error: "Failed to cancel eval job" });
    }
  });

  // Admin: Get stale running jobs
  app.get("/api/admin/eval-jobs/stale", requireAuth, requireAdmin, async (req, res) => {
    try {
      const staleJobs = await storage.getStaleRunningJobs(5);
      res.json(staleJobs);
    } catch (error) {
      console.error("Error fetching stale jobs:", error);
      res.status(500).json({ error: "Failed to fetch stale jobs" });
    }
  });

  // Admin: Force release stale jobs
  app.post("/api/admin/eval-jobs/release-stale", requireAuth, requireAdmin, async (req, res) => {
    try {
      const released = await storage.releaseStaleJobs(5);
      res.json({ message: `Released ${released} stale job(s)`, released });
    } catch (error) {
      console.error("Error releasing stale jobs:", error);
      res.status(500).json({ error: "Failed to release stale jobs" });
    }
  });

  // ==================== METRICS ROUTES ====================

  // Helper to transform DB eval results into the format the dashboard expects.
  // Accepts both raw rows and daily-bucket aggregates (both are MetricSourceRow).
  async function formatMetricsResults(results: MetricSourceRow[]) {
    const providerCache = new Map<string, string>();
    const allProviders = await storage.getAllProviders();
    for (const p of allProviders) {
      providerCache.set(p.id, p.name);
    }
    return results.map(r => ({
      id: r.id,
      providerId: r.providerId,
      provider: providerCache.get(r.providerId) || r.providerId,
      region: r.region,
      responseLatency: r.responseLatencyMedian,
      responseLatencySd: r.responseLatencySd,
      responseLatencyP95: r.responseLatencyP95,
      interruptLatency: r.interruptLatencyMedian,
      interruptLatencySd: r.interruptLatencySd,
      interruptLatencyP95: r.interruptLatencyP95,
      networkResilience: r.networkResilience || 0,
      naturalness: r.naturalness || 0,
      noiseReduction: r.noiseReduction || 0,
      timestamp: r.createdAt,
      // Workflow identity for the hover tooltip (raw rows only; null on buckets).
      workflowId: r.workflowId ?? null,
      workflowName: r.workflowName ?? null,
    }));
  }

  // Simple TTL cache for metrics queries (30s) — prevents identical 7-table joins from hammering the DB
  const metricsCache = new Map<string, { data: unknown; expiry: number }>();
  const CACHE_TTL = 30000; // 30 seconds

  function getCached<T>(key: string): T | null {
    const entry = metricsCache.get(key);
    if (entry && Date.now() < entry.expiry) return entry.data as T;
    return null;
  }

  function setCache(key: string, data: unknown): void {
    metricsCache.set(key, { data, expiry: Date.now() + CACHE_TTL });
  }

  // Parse the only client-supplied metrics knob: the time window. `hours` must be
  // a positive integer; absent means "all time". The client `limit` is ignored —
  // the server alone decides row counts / raw-vs-bucket (see storage.tierMetrics).
  // Returns { hoursBack } on success, or { error } describing a 400.
  function parseMetricsWindow(hours: unknown): { hoursBack?: number } | { error: string } {
    if (hours === undefined) return {};
    const parsed = Number(hours);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { error: "hours must be a positive integer (omit for all time)" };
    }
    return { hoursBack: parsed };
  }

  app.get("/api/metrics/realtime", async (req, res) => {
    try {
      const win = parseMetricsWindow(req.query.hours);
      if ("error" in win) return res.status(400).json({ error: win.error });
      const cacheKey = `realtime:${win.hoursBack ?? 'all'}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      const results = await storage.getMainlineMetrics(win.hoursBack);
      const data = await formatMetricsResults(results);
      setCache(cacheKey, data);
      res.json(data);
    } catch (error) {
      console.error("Error fetching realtime metrics:", error);
      res.status(500).json({ error: "Failed to fetch metrics" });
    }
  });

  app.get("/api/metrics/community", async (req, res) => {
    try {
      const win = parseMetricsWindow(req.query.hours);
      if ("error" in win) return res.status(400).json({ error: win.error });
      const cacheKey = `community:${win.hoursBack ?? 'all'}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      const results = await storage.getCommunityMetrics(win.hoursBack);
      const data = await formatMetricsResults(results);
      setCache(cacheKey, data);
      res.json(data);
    } catch (error) {
      console.error("Error fetching community metrics:", error);
      res.status(500).json({ error: "Failed to fetch community metrics" });
    }
  });

  app.get("/api/metrics/my-evals", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const win = parseMetricsWindow(req.query.hours);
      if ("error" in win) return res.status(400).json({ error: win.error });
      const cacheKey = `my-evals:${user.id}:${win.hoursBack ?? 'all'}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      const results = await storage.getMyEvalMetrics(user.id, win.hoursBack);
      const data = await formatMetricsResults(results);
      setCache(cacheKey, data);
      res.json(data);
    } catch (error) {
      console.error("Error fetching my eval metrics:", error);
      res.status(500).json({ error: "Failed to fetch my eval metrics" });
    }
  });

  app.get("/api/metrics/leaderboard", async (req, res) => {
    try {
      const { hours } = req.query;
      const cacheKey = `leaderboard:${hours || 'all'}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      const hoursBack = hours ? parseInt(hours as string) : undefined;
      const results = await storage.getMainlineEvalResults(1000, hoursBack);

      // Group results by (provider, region)
      const providerRegionMap = new Map<string, {
        providerId: string;
        region: string;
        responseLatencies: number[];
        responseLatenciesP95: number[];
        interruptLatencies: number[];
        interruptLatenciesP95: number[];
        networkResiliences: number[];
        naturalnesses: number[];
        noiseReductions: number[];
      }>();

      for (const result of results) {
        const key = `${result.providerId}-${result.region}`;
        if (!providerRegionMap.has(key)) {
          providerRegionMap.set(key, {
            providerId: result.providerId,
            region: result.region,
            responseLatencies: [],
            responseLatenciesP95: [],
            interruptLatencies: [],
            interruptLatenciesP95: [],
            networkResiliences: [],
            naturalnesses: [],
            noiseReductions: [],
          });
        }
        const group = providerRegionMap.get(key)!;
        group.responseLatencies.push(result.responseLatencyMedian);
        group.responseLatenciesP95.push(result.responseLatencyP95);
        group.interruptLatencies.push(result.interruptLatencyMedian);
        group.interruptLatenciesP95.push(result.interruptLatencyP95);
        if (result.networkResilience != null) group.networkResiliences.push(result.networkResilience);
        if (result.naturalness != null) group.naturalnesses.push(result.naturalness);
        if (result.noiseReduction != null) group.noiseReductions.push(result.noiseReduction);
      }

      const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

      // Aggregate metrics per group
      const entries = await Promise.all(
        Array.from(providerRegionMap.values()).map(async (group) => {
          const provider = await storage.getProvider(group.providerId);
          return {
            providerId: group.providerId,
            provider: provider?.name || "Unknown",
            region: group.region,
            responseLatency: Math.round(avg(group.responseLatencies)),
            responseLatencyP95: Math.round(avg(group.responseLatenciesP95)),
            interruptLatency: Math.round(avg(group.interruptLatencies)),
            interruptLatencyP95: Math.round(avg(group.interruptLatenciesP95)),
            networkResilience: Math.round(avg(group.networkResiliences)),
            naturalness: Math.round(avg(group.naturalnesses) * 10) / 10,
            noiseReduction: Math.round(avg(group.noiseReductions)),
          };
        })
      );

      if (entries.length === 0) {
        return res.json([]);
      }

      // Min-max normalization + weighted composite score
      // Weights: response 30%, interrupt 25%, noise 20%, network 15%, naturalness 10%
      const weights = {
        responseLatency:  { w: 0.30, lowerIsBetter: true },
        interruptLatency: { w: 0.25, lowerIsBetter: true },
        noiseReduction:   { w: 0.20, lowerIsBetter: false },
        networkResilience:{ w: 0.15, lowerIsBetter: false },
        naturalness:      { w: 0.10, lowerIsBetter: false },
      } as const;

      type MetricKey = keyof typeof weights;
      const metricKeys = Object.keys(weights) as MetricKey[];

      // Compute min/max for each metric
      const ranges: Record<string, { min: number; max: number }> = {};
      for (const key of metricKeys) {
        const values = entries.map(e => e[key]);
        ranges[key] = { min: Math.min(...values), max: Math.max(...values) };
      }

      // Normalize and compute composite score
      const scored = entries.map(entry => {
        let composite = 0;
        let totalWeight = 0;

        for (const key of metricKeys) {
          const { min, max } = ranges[key];
          const { w, lowerIsBetter } = weights[key];

          if (min === max) {
            // All entries have the same value — full score
            composite += w;
            totalWeight += w;
          } else {
            const normalized = lowerIsBetter
              ? (max - entry[key]) / (max - min)
              : (entry[key] - min) / (max - min);
            composite += w * normalized;
            totalWeight += w;
          }
        }

        // Redistribute if some weights were skipped (shouldn't happen but safety)
        const score = totalWeight > 0 ? composite / totalWeight : 0;
        return { ...entry, compositeScore: Math.round(score * 1000) / 1000 };
      });

      // Rank by composite score descending (highest = best)
      const sorted = scored
        .sort((a, b) => b.compositeScore - a.compositeScore)
        .map((entry, index) => ({ rank: index + 1, ...entry }));

      setCache(cacheKey, sorted);
      res.json(sorted);
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });

  // ==================== CONFIG ROUTES ====================

  app.get("/api/config", async (req, res) => {
    try {
      const PUBLIC_CONFIG_KEYS = new Set(["system_initialized"]);
      const configs = await storage.getAllConfig();
      const configObject: Record<string, string> = {};
      for (const config of configs) {
        if (PUBLIC_CONFIG_KEYS.has(config.key)) {
          configObject[config.key] = config.value;
        }
      }
      res.json(configObject);
    } catch (error) {
      console.error("Error fetching config:", error);
      res.status(500).json({ error: "Failed to fetch config" });
    }
  });

  // ==================== HEALTH ROUTES ====================

  app.get("/api/health", async (_req, res) => {
    try {
      const agents = await storage.getAllEvalAgents();
      const online = agents.filter(a => a.state !== "offline");
      const total = agents.length;
      const onlineCount = online.length;

      // Operational: at least one agent is online
      // Degraded: agents exist but all offline
      // Down: no agents registered at all
      let status: "operational" | "degraded" | "down";
      if (onlineCount > 0) {
        status = "operational";
      } else if (total > 0) {
        status = "degraded";
      } else {
        status = "degraded";
      }

      res.json({
        status,
        agents: { total, online: onlineCount, offline: total - onlineCount },
      });
    } catch (error) {
      console.error("Error checking health:", error);
      res.status(500).json({ status: "down", agents: { total: 0, online: 0, offline: 0 } });
    }
  });

  // ==================== ORGANIZATION ROUTES ====================

  // Create organization (user becomes admin and gets linked)
  app.post("/api/organizations", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (user.organizationId) {
        return res.status(400).json({ error: "Already a member of an organization" });
      }

      const { name, address } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Organization name required" });
      }

      // Create organization
      const org = await storage.createOrganization({
        name,
        address,
        verified: false,
      });

      // Create organization seat record
      await storage.createOrganizationSeat({
        organizationId: org.id,
        totalSeats: 0,
        usedSeats: 1, // Creator takes a seat
        pricePerSeat: 600,
        discountPercent: 0,
      });

      // Link user to organization as owner
      await storage.updateUser(user.id, {
        organizationId: org.id,
        orgRole: 'owner',
      });

      res.json(org);
    } catch (error) {
      console.error("Error creating organization:", error);
      res.status(500).json({ error: "Failed to create organization" });
    }
  });

  // Get organization details
  app.get("/api/organizations/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const org = await storage.getOrganization(parseInt(id));

      if (!org) {
        return res.status(404).json({ error: "Organization not found" });
      }

      // Must be member or system admin
      if (user.organizationId !== org.id && !user.isAdmin) {
        return res.status(403).json({ error: "Not authorized to view this organization" });
      }

      res.json(org);
    } catch (error) {
      console.error("Error fetching organization:", error);
      res.status(500).json({ error: "Failed to fetch organization" });
    }
  });

  // Update organization (org admin only)
  app.patch("/api/organizations/:id", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const { name, address } = req.body;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized to modify this organization" });
      }

      const updates: Record<string, unknown> = {};
      if (name) updates.name = name;
      if (address !== undefined) updates.address = address;

      const updated = await storage.updateOrganization(parseInt(id), updates);
      res.json(updated);
    } catch (error) {
      console.error("Error updating organization:", error);
      res.status(500).json({ error: "Failed to update organization" });
    }
  });

  // Invite user to organization
  app.post("/api/organizations/:id/invite", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: "Email required" });
      }

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized to invite to this organization" });
      }

      // Check if organization has available seats
      const seats = await storage.getOrganizationSeat(parseInt(id));
      if (seats && seats.usedSeats >= seats.totalSeats) {
        return res.status(400).json({ error: "No available seats. Please purchase more seats." });
      }

      const existing = await storage.getUserByEmail(email);
      if (existing) {
        return res.status(400).json({ error: "Email already registered" });
      }

      const token = generateToken();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await storage.createInviteToken(
        email,
        "premium", // Org members get premium
        false, // Not org admin by default
        tokenHash,
        user.id,
        expiresAt,
        parseInt(id)
      );

      res.json({
        message: "Invite created",
        token,
        expiresAt,
      });
    } catch (error) {
      console.error("Error creating invite:", error);
      res.status(500).json({ error: "Failed to create invite" });
    }
  });

  // List organization members
  app.get("/api/organizations/:id/members", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;

      // Must be member of the organization
      if (user.organizationId !== parseInt(id) && !user.isAdmin) {
        return res.status(403).json({ error: "Not authorized to view members" });
      }

      const members = await storage.getUsersByOrganization(parseInt(id));
      res.json(members.map(m => ({
        id: m.id,
        username: m.username,
        email: m.email,
        plan: m.plan,
        orgRole: m.orgRole,
        createdAt: m.createdAt,
      })));
    } catch (error) {
      console.error("Error fetching members:", error);
      res.status(500).json({ error: "Failed to fetch members" });
    }
  });

  // Update member role (org admin only)
  app.patch("/api/organizations/:id/members/:userId", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id, userId } = req.params;
      const { orgRole } = req.body;

      if (!orgRole || !['admin', 'member'].includes(orgRole)) {
        return res.status(400).json({ error: "orgRole must be 'admin' or 'member'" });
      }

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized to modify this organization" });
      }

      const member = await storage.getUser(parseInt(userId));
      if (!member || member.organizationId !== parseInt(id)) {
        return res.status(404).json({ error: "Member not found in organization" });
      }

      // Cannot change owner role
      if (member.orgRole === 'owner') {
        return res.status(400).json({ error: "Cannot change owner role" });
      }

      // Cannot demote yourself
      if (parseInt(userId) === user.id) {
        return res.status(400).json({ error: "Cannot change your own role" });
      }

      // Only owner can promote to admin
      if (orgRole === 'admin' && user.orgRole !== 'owner') {
        return res.status(403).json({ error: "Only owner can promote to admin" });
      }

      // Check max org admins (4)
      if (orgRole === 'admin') {
        const adminCount = await storage.countOrgAdmins(parseInt(id));
        if (adminCount >= 4) {
          return res.status(400).json({ error: "Maximum 4 organization admins allowed" });
        }
      }

      const updated = await storage.updateUser(parseInt(userId), { orgRole });
      res.json({
        id: updated?.id,
        username: updated?.username,
        orgRole: updated?.orgRole,
      });
    } catch (error) {
      console.error("Error updating member:", error);
      res.status(500).json({ error: "Failed to update member" });
    }
  });

  // Remove member from organization (org admin only)
  app.delete("/api/organizations/:id/members/:userId", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id, userId } = req.params;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized to modify this organization" });
      }

      const member = await storage.getUser(parseInt(userId));
      if (!member || member.organizationId !== parseInt(id)) {
        return res.status(404).json({ error: "Member not found in organization" });
      }

      // Cannot remove yourself
      if (parseInt(userId) === user.id) {
        return res.status(400).json({ error: "Cannot remove yourself. Use leave organization instead." });
      }

      // Cannot remove the owner
      if (member.orgRole === 'owner') {
        return res.status(400).json({ error: "Cannot remove the organization owner" });
      }

      await storage.removeUserFromOrganization(parseInt(userId));

      // Update seat count
      const seats = await storage.getOrganizationSeat(parseInt(id));
      if (seats) {
        await storage.updateOrganizationSeat(parseInt(id), {
          usedSeats: Math.max(0, seats.usedSeats - 1),
        });
      }

      res.json({ message: "Member removed from organization" });
    } catch (error) {
      console.error("Error removing member:", error);
      res.status(500).json({ error: "Failed to remove member" });
    }
  });

  // Leave organization
  app.post("/api/organizations/:id/leave", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not a member of this organization" });
      }

      // Owner cannot leave — must transfer ownership first
      if (user.orgRole === 'owner') {
        return res.status(400).json({ error: "Owner cannot leave. Transfer ownership first." });
      }

      await storage.removeUserFromOrganization(user.id);

      // Update seat count
      const seats = await storage.getOrganizationSeat(parseInt(id));
      if (seats) {
        await storage.updateOrganizationSeat(parseInt(id), {
          usedSeats: Math.max(0, seats.usedSeats - 1),
        });
      }

      res.json({ message: "Left organization successfully" });
    } catch (error) {
      console.error("Error leaving organization:", error);
      res.status(500).json({ error: "Failed to leave organization" });
    }
  });

  // Admin: Verify/unverify organization
  app.patch("/api/admin/organizations/:id/verify", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { verified } = req.body;

      const org = await storage.getOrganization(parseInt(id));
      if (!org) {
        return res.status(404).json({ error: "Organization not found" });
      }

      const updated = await storage.updateOrganization(parseInt(id), { verified });
      res.json(updated);
    } catch (error) {
      console.error("Error verifying organization:", error);
      res.status(500).json({ error: "Failed to verify organization" });
    }
  });

  // Admin: List all organizations
  app.get("/api/admin/organizations", requireAuth, requireAdmin, async (req, res) => {
    try {
      const orgs = await storage.getAllOrganizations();

      // Get member counts for each org
      const orgsWithCounts = await Promise.all(
        orgs.map(async (org) => {
          const memberCount = await storage.getOrganizationMemberCount(org.id);
          const seats = await storage.getOrganizationSeat(org.id);
          return {
            ...org,
            memberCount,
            totalSeats: seats?.totalSeats || 0,
            usedSeats: seats?.usedSeats || 0,
          };
        })
      );

      res.json(orgsWithCounts);
    } catch (error) {
      console.error("Error fetching organizations:", error);
      res.status(500).json({ error: "Failed to fetch organizations" });
    }
  });

  // Get current user's organization
  app.get("/api/user/organization", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (!user.organizationId) {
        return res.json(null);
      }

      const org = await storage.getOrganization(user.organizationId);
      const seats = await storage.getOrganizationSeat(user.organizationId);
      const memberCount = await storage.getOrganizationMemberCount(user.organizationId);

      res.json({
        ...org,
        memberCount,
        totalSeats: seats?.totalSeats || 0,
        usedSeats: seats?.usedSeats || 0,
        orgRole: user.orgRole,
      });
    } catch (error) {
      console.error("Error fetching user organization:", error);
      res.status(500).json({ error: "Failed to fetch organization" });
    }
  });

  // ==================== SEAT MANAGEMENT ROUTES ====================

  // Get pricing tiers
  app.get("/api/pricing", async (req, res) => {
    try {
      const pricing = await storage.getAllPricingConfig();
      res.json(pricing.filter(p => p.name !== "Solo Premium"));
    } catch (error) {
      console.error("Error fetching pricing:", error);
      res.status(500).json({ error: "Failed to fetch pricing" });
    }
  });

  // Get organization seat info
  app.get("/api/organizations/:id/seats", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized to view seats" });
      }

      const seats = await storage.getOrganizationSeat(parseInt(id));
      if (!seats) {
        return res.json({
          totalSeats: 0,
          usedSeats: 0,
          availableSeats: 0,
        });
      }

      res.json({
        totalSeats: seats.totalSeats,
        usedSeats: seats.usedSeats,
        availableSeats: Math.max(0, seats.totalSeats - seats.usedSeats),
        pricePerSeat: seats.pricePerSeat,
        discountPercent: seats.discountPercent,
      });
    } catch (error) {
      console.error("Error fetching seats:", error);
      res.status(500).json({ error: "Failed to fetch seats" });
    }
  });

  // Calculate price for additional seats
  app.post("/api/organizations/:id/seats/calculate", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const { additionalSeats } = req.body;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized" });
      }

      if (!additionalSeats || additionalSeats <= 0) {
        return res.status(400).json({ error: "Invalid number of seats" });
      }

      const seats = await storage.getOrganizationSeat(parseInt(id));
      const currentSeats = seats?.totalSeats || 0;

      const calculation = await calculateSeatPrice(currentSeats, additionalSeats);
      if (!calculation) {
        return res.status(500).json({ error: "Failed to calculate price" });
      }

      res.json(calculation);
    } catch (error) {
      console.error("Error calculating price:", error);
      res.status(500).json({ error: "Failed to calculate price" });
    }
  });

  // Purchase seats
  app.post("/api/organizations/:id/seats/purchase", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const { additionalSeats, paymentMethodId } = req.body;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized" });
      }

      if (!additionalSeats || additionalSeats <= 0) {
        return res.status(400).json({ error: "Invalid number of seats" });
      }

      const seats = await storage.getOrganizationSeat(parseInt(id));
      const currentSeats = seats?.totalSeats || 0;

      const calculation = await calculateSeatPrice(currentSeats, additionalSeats);
      if (!calculation) {
        return res.status(500).json({ error: "Failed to calculate price" });
      }

      // Process payment if Stripe is configured and payment method provided
      let paymentResult = null;
      if (isStripeConfigured() && paymentMethodId) {
        const paymentMethod = await storage.getPaymentMethod(paymentMethodId);
        if (!paymentMethod || paymentMethod.organizationId !== parseInt(id)) {
          return res.status(400).json({ error: "Invalid payment method" });
        }

        if (!paymentMethod.stripeCustomerId || !paymentMethod.stripePaymentMethodId) {
          return res.status(400).json({ error: "Payment method not properly configured" });
        }

        paymentResult = await createPaymentIntent(
          paymentMethod.stripeCustomerId,
          calculation.total,
          paymentMethod.stripePaymentMethodId,
          `Purchase ${additionalSeats} seats for organization`
        );

        if (!paymentResult || paymentResult.status !== "succeeded") {
          return res.status(400).json({ error: "Payment failed" });
        }

        // Record payment history
        await storage.createPaymentHistory({
          organizationId: parseInt(id),
          userId: user.id,
          amount: calculation.total,
          status: "completed",
          description: `Purchased ${additionalSeats} seats`,
          stripePaymentIntentId: paymentResult.id,
        });
      } else if (!isStripeConfigured() || isStripeTestMode()) {
        // For testing without Stripe or with test keys - just record the purchase
        await storage.createPaymentHistory({
          organizationId: parseInt(id),
          userId: user.id,
          amount: calculation.total,
          status: "completed",
          description: `Purchased ${additionalSeats} seats (test mode)`,
        });
      } else {
        return res.status(400).json({ error: "Payment method required" });
      }

      // Update seat count
      await storage.updateOrganizationSeat(parseInt(id), {
        totalSeats: calculation.totalSeats,
        pricePerSeat: calculation.pricePerSeat,
        discountPercent: calculation.discountPercent,
      });

      res.json({
        message: "Seats purchased successfully",
        newTotalSeats: calculation.totalSeats,
        amountPaid: calculation.total,
      });
    } catch (error) {
      console.error("Error purchasing seats:", error);
      res.status(500).json({ error: "Failed to purchase seats" });
    }
  });

  // ==================== PAYMENT ROUTES ====================

  // Get Stripe configuration for frontend
  app.get("/api/payments/stripe-config", (req, res) => {
    const publishableKey = getStripePublishableKey();
    res.json({
      enabled: isStripeConfigured(),
      publishableKey,
    });
  });

  // Create setup intent for adding card
  app.post("/api/organizations/:id/payments/setup-intent", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized" });
      }

      if (!isStripeConfigured()) {
        return res.status(503).json({ error: "Stripe not configured" });
      }

      const org = await storage.getOrganization(parseInt(id));
      if (!org) {
        return res.status(404).json({ error: "Organization not found" });
      }

      // Check if org has a Stripe customer, if not create one
      const existingMethod = await storage.getDefaultPaymentMethod(parseInt(id));
      let customerId = existingMethod?.stripeCustomerId;

      if (!customerId) {
        const customer = await createStripeCustomer(
          user.email,
          org.name,
          { organizationId: id }
        );
        if (!customer) {
          return res.status(500).json({ error: "Failed to create Stripe customer" });
        }
        customerId = customer.id;
      }

      const setupIntent = await createSetupIntent(customerId);
      if (!setupIntent) {
        return res.status(500).json({ error: "Failed to create setup intent" });
      }

      res.json({
        clientSecret: setupIntent.clientSecret,
        customerId,
      });
    } catch (error) {
      console.error("Error creating setup intent:", error);
      res.status(500).json({ error: "Failed to create setup intent" });
    }
  });

  // Save payment method
  app.post("/api/organizations/:id/payments/methods", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const { stripePaymentMethodId, stripeCustomerId, setDefault } = req.body;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized" });
      }

      if (!stripePaymentMethodId || !stripeCustomerId) {
        return res.status(400).json({ error: "Payment method ID and customer ID required" });
      }

      // Attach payment method to customer
      const attached = await attachPaymentMethod(stripePaymentMethodId, stripeCustomerId);
      if (!attached) {
        return res.status(500).json({ error: "Failed to attach payment method" });
      }

      // Get card details
      const details = await getPaymentMethodDetails(stripePaymentMethodId);

      const paymentMethod = await storage.createPaymentMethod({
        organizationId: parseInt(id),
        stripeCustomerId,
        stripePaymentMethodId,
        isDefault: setDefault || false,
        lastFour: details?.lastFour,
        expiryMonth: details?.expiryMonth,
        expiryYear: details?.expiryYear,
      });

      if (setDefault) {
        await storage.setDefaultPaymentMethod(parseInt(id), paymentMethod.id);
      }

      res.json({
        id: paymentMethod.id,
        lastFour: paymentMethod.lastFour,
        expiryMonth: paymentMethod.expiryMonth,
        expiryYear: paymentMethod.expiryYear,
        isDefault: paymentMethod.isDefault,
      });
    } catch (error) {
      console.error("Error saving payment method:", error);
      res.status(500).json({ error: "Failed to save payment method" });
    }
  });

  // List payment methods
  app.get("/api/organizations/:id/payments/methods", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const methods = await storage.getPaymentMethodsByOrganization(parseInt(id));
      res.json(methods.map(m => ({
        id: m.id,
        lastFour: m.lastFour,
        expiryMonth: m.expiryMonth,
        expiryYear: m.expiryYear,
        isDefault: m.isDefault,
        createdAt: m.createdAt,
      })));
    } catch (error) {
      console.error("Error fetching payment methods:", error);
      res.status(500).json({ error: "Failed to fetch payment methods" });
    }
  });

  // Delete payment method
  app.delete("/api/organizations/:id/payments/methods/:methodId", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id, methodId } = req.params;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const method = await storage.getPaymentMethod(parseInt(methodId));
      if (!method || method.organizationId !== parseInt(id)) {
        return res.status(404).json({ error: "Payment method not found" });
      }

      // Detach from Stripe
      if (method.stripePaymentMethodId) {
        await detachPaymentMethod(method.stripePaymentMethodId);
      }

      await storage.deletePaymentMethod(parseInt(methodId));
      res.json({ message: "Payment method deleted" });
    } catch (error) {
      console.error("Error deleting payment method:", error);
      res.status(500).json({ error: "Failed to delete payment method" });
    }
  });

  // Get payment history
  app.get("/api/organizations/:id/payments/history", requireAuth, requireOrgAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const history = await storage.getPaymentHistoriesByOrganization(parseInt(id));
      res.json(history);
    } catch (error) {
      console.error("Error fetching payment history:", error);
      res.status(500).json({ error: "Failed to fetch payment history" });
    }
  });

  // ==================== FUND RETURN ROUTES ====================

  // Request fund return (Premium users only)
  app.post("/api/fund-returns", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (user.plan !== "premium") {
        return res.status(403).json({ error: "Only Premium users can request fund returns" });
      }

      const { amount, reason } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }

      const request = await storage.createFundReturnRequest({
        userId: user.id,
        amount,
        reason,
        status: "pending",
      });

      res.json(request);
    } catch (error) {
      console.error("Error creating fund return request:", error);
      res.status(500).json({ error: "Failed to create fund return request" });
    }
  });

  // Get user's fund return requests
  app.get("/api/user/fund-returns", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const requests = await storage.getFundReturnRequestsByUser(user.id);
      res.json(requests);
    } catch (error) {
      console.error("Error fetching fund return requests:", error);
      res.status(500).json({ error: "Failed to fetch fund return requests" });
    }
  });

  // Admin: List all fund return requests
  app.get("/api/admin/fund-returns", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { status } = req.query;

      let requests;
      if (status === "pending") {
        requests = await storage.getPendingFundReturnRequests();
      } else {
        requests = await storage.getAllFundReturnRequests();
      }

      // Add user info
      const requestsWithUsers = await Promise.all(
        requests.map(async (request) => {
          const user = await storage.getUser(request.userId);
          return {
            ...request,
            user: user ? {
              id: user.id,
              username: user.username,
              email: user.email,
            } : null,
          };
        })
      );

      res.json(requestsWithUsers);
    } catch (error) {
      console.error("Error fetching fund return requests:", error);
      res.status(500).json({ error: "Failed to fetch fund return requests" });
    }
  });

  // Admin: Approve/reject fund return request
  app.patch("/api/admin/fund-returns/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const { status } = req.body;

      if (!status || !["approved", "rejected"].includes(status)) {
        return res.status(400).json({ error: "Invalid status. Must be approved or rejected" });
      }

      const request = await storage.getFundReturnRequest(parseInt(id));
      if (!request) {
        return res.status(404).json({ error: "Fund return request not found" });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request already processed" });
      }

      const updated = await storage.reviewFundReturnRequest(
        parseInt(id),
        user.id,
        status as "approved" | "rejected"
      );

      res.json(updated);
    } catch (error) {
      console.error("Error reviewing fund return request:", error);
      res.status(500).json({ error: "Failed to review fund return request" });
    }
  });

  // ==================== STRIPE WEBHOOK ROUTES ====================

  // Stripe webhook handler - must use raw body
  app.post("/api/webhooks/stripe", async (req, res) => {
    try {
      const signature = req.headers["stripe-signature"] as string;

      if (!signature) {
        return res.status(400).json({ error: "Missing stripe-signature header" });
      }

      // Get raw body from the verify callback in express.json middleware
      const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;

      const event = await constructWebhookEvent(rawBody, signature);
      if (!event) {
        return res.status(400).json({ error: "Invalid webhook signature" });
      }

      // Handle specific event types
      switch (event.type) {
        case "payment_intent.succeeded": {
          const paymentIntent = event.data.object as Record<string, unknown>;
          console.log(`Payment succeeded: ${paymentIntent.id}`);

          // Update payment history if exists
          const existingPayment = await storage.getPaymentHistoryByStripeId(
            paymentIntent.id as string
          );
          if (existingPayment) {
            await storage.updatePaymentHistoryStatus(existingPayment.id, "completed");
          }
          break;
        }

        case "payment_intent.payment_failed": {
          const paymentIntent = event.data.object as Record<string, unknown>;
          console.log(`Payment failed: ${paymentIntent.id}`);

          const existingPayment = await storage.getPaymentHistoryByStripeId(
            paymentIntent.id as string
          );
          if (existingPayment) {
            await storage.updatePaymentHistoryStatus(existingPayment.id, "failed");
          }
          break;
        }

        case "setup_intent.succeeded": {
          const setupIntent = event.data.object as Record<string, unknown>;
          console.log(`Setup intent succeeded: ${setupIntent.id}`);
          break;
        }

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error("Webhook error:", error);
      res.status(500).json({ error: "Webhook handler failed" });
    }
  });

  // ==================== DEV-ONLY ROUTES ====================
  if (process.env["NODE_ENV"] !== "production") {
    const { chiselMiddleware } = await import("@agora-build/chisel-dev/middleware");
    chiselMiddleware(app, {
      cssFile: "client/src/index.css",
      srcDirs: ["client/src"],
      extensions: [".tsx", ".ts", ".jsx", ".js"],
    });
  }

  // ==================== CLASH API ROUTES ====================

  // --- Console APIs (requireAuth) ---

  // List user's agent profiles (+ public profiles they can challenge)
  app.get("/api/clash/profiles", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const ownProfiles = await storage.getClashAgentProfilesByOwner(user.id);
      const publicProfiles = await storage.getPublicClashAgentProfiles();
      // Deduplicate: own profiles + public profiles not owned by user
      const publicOthers = publicProfiles.filter(p => p.ownerId !== user.id);
      res.json({ ownProfiles, publicProfiles: publicOthers });
    } catch (error) {
      console.error("Error listing clash profiles:", error);
      res.status(500).json({ error: "Failed to list profiles" });
    }
  });

  // Create agent profile
  app.post("/api/clash/profiles", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { name, agentUrl, providerId, setupSteps, visibility } = req.body;
      if (!name || !agentUrl) {
        return res.status(400).json({ error: "Name and agentUrl are required" });
      }

      // Only premium+ can create public profiles
      const vis = (visibility === "public" && user.plan !== "basic") ? "public" : "private";

      const profile = await storage.createClashAgentProfile({
        name,
        agentUrl,
        ownerId: user.id,
        providerId: providerId || null,
        setupSteps: setupSteps || [],
        visibility: vis,
      });
      res.status(201).json(profile);
    } catch (error) {
      console.error("Error creating clash profile:", error);
      res.status(500).json({ error: "Failed to create profile" });
    }
  });

  // Update agent profile
  app.patch("/api/clash/profiles/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const profileId = parseInt(req.params.id);

      const existing = await storage.getClashAgentProfile(profileId);
      if (!existing) return res.status(404).json({ error: "Profile not found" });
      if (existing.ownerId !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const { name, agentUrl, providerId, setupSteps, visibility } = req.body;
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (agentUrl !== undefined) updates.agentUrl = agentUrl;
      if (providerId !== undefined) updates.providerId = providerId;
      if (setupSteps !== undefined) updates.setupSteps = setupSteps;
      if (visibility !== undefined) {
        updates.visibility = (visibility === "public" && user.plan !== "basic") ? "public" : "private";
      }

      const updated = await storage.updateClashAgentProfile(profileId, updates);
      res.json(updated);
    } catch (error) {
      console.error("Error updating clash profile:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // Delete agent profile
  app.delete("/api/clash/profiles/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const profileId = parseInt(req.params.id);

      const existing = await storage.getClashAgentProfile(profileId);
      if (!existing) return res.status(404).json({ error: "Profile not found" });
      if (existing.ownerId !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Not authorized" });
      }

      await storage.deleteClashAgentProfile(profileId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting clash profile:", error);
      res.status(500).json({ error: "Failed to delete profile" });
    }
  });

  // ==================== CLASH EVENTS (v2) ====================

  // List user's events
  app.get("/api/clash/events", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const events = await storage.getClashEventsByUser(user.id);
      res.json(events);
    } catch (error) {
      console.error("Error listing clash events:", error);
      res.status(500).json({ error: "Failed to list events" });
    }
  });

  // Create event with matchups array
  app.post("/api/clash/events", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { name, description, region, visibility, scheduledAt, matchups } = req.body;
      if (!name || !region || !matchups || !Array.isArray(matchups) || matchups.length === 0) {
        return res.status(400).json({ error: "name, region, and matchups array are required" });
      }

      // Validate all matchups
      for (let i = 0; i < matchups.length; i++) {
        const m = matchups[i];
        if (!m.agentAProfileId || !m.agentBProfileId || !m.topic) {
          return res.status(400).json({ error: `matchup[${i}]: agentAProfileId, agentBProfileId, and topic are required` });
        }
        if (m.agentAProfileId === m.agentBProfileId) {
          return res.status(400).json({ error: `matchup[${i}]: Cannot clash an agent against itself` });
        }
        const profileA = await storage.getClashAgentProfile(m.agentAProfileId);
        const profileB = await storage.getClashAgentProfile(m.agentBProfileId);
        if (!profileA || !profileB) {
          return res.status(404).json({ error: `matchup[${i}]: One or both agent profiles not found` });
        }
        const aAccessible = profileA.ownerId === user.id || profileA.visibility === "public";
        const bAccessible = profileB.ownerId === user.id || profileB.visibility === "public";
        if (!aAccessible || !bAccessible) {
          return res.status(403).json({ error: `matchup[${i}]: Cannot access one or both agent profiles` });
        }
      }

      // Create the event
      const event = await storage.createClashEvent({
        name,
        description: description || null,
        createdBy: user.id,
        region,
        status: "upcoming",
        visibility: visibility || "public",
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        agoraChannelName: null,
        moderatorAgentId: null,
      });

      // Set Agora channel name for the event
      if (isAgoraConfigured()) {
        const channelName = generateEventChannelName(event.id);
        await storage.updateClashEvent(event.id, { agoraChannelName: channelName });
      }

      // Create match rows for each matchup
      const matches = [];
      for (let i = 0; i < matchups.length; i++) {
        const m = matchups[i];
        const match = await storage.createClashMatch({
          eventId: event.id,
          matchOrder: i + 1,
          agentAProfileId: m.agentAProfileId,
          agentBProfileId: m.agentBProfileId,
          topic: m.topic,
          maxDurationSeconds: m.maxDurationSeconds || 300,
          config: {},
          status: "pending",
          runnerId: null,
          recordingUrl: null,
          durationSeconds: null,
          error: null,
        });
        matches.push(match);
      }

      const updatedEvent = await storage.getClashEvent(event.id);
      res.status(201).json({ ...updatedEvent, matches });
    } catch (error) {
      console.error("Error creating clash event:", error);
      res.status(500).json({ error: "Failed to create event" });
    }
  });

  // Event detail + matches (public)
  app.get("/api/clash/events/:id", async (req, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const event = await storage.getClashEvent(eventId);
      if (!event) return res.status(404).json({ error: "Event not found" });

      const matches = await storage.getClashMatchesByEvent(eventId);
      // Enrich matches with agent profile names
      const enrichedMatches = await Promise.all(matches.map(async (m) => {
        const profileA = await storage.getClashAgentProfile(m.agentAProfileId);
        const profileB = await storage.getClashAgentProfile(m.agentBProfileId);
        return {
          ...m,
          agentAName: profileA?.name || "Unknown",
          agentBName: profileB?.name || "Unknown",
        };
      }));

      res.json({ ...event, matches: enrichedMatches });
    } catch (error) {
      console.error("Error getting clash event:", error);
      res.status(500).json({ error: "Failed to get event" });
    }
  });

  // Start event manually
  app.post("/api/clash/events/:id/start", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const eventId = parseInt(req.params.id);

      const event = await storage.getClashEvent(eventId);
      if (!event) return res.status(404).json({ error: "Event not found" });
      if (event.createdBy !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Not authorized" });
      }
      if (event.status !== "upcoming") {
        return res.status(400).json({ error: "Can only start upcoming events" });
      }

      const updated = await storage.updateClashEvent(eventId, {
        status: "live",
        startedAt: new Date(),
      });
      res.json(updated);
    } catch (error) {
      console.error("Error starting clash event:", error);
      res.status(500).json({ error: "Failed to start event" });
    }
  });

  // Cancel event
  app.post("/api/clash/events/:id/cancel", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const eventId = parseInt(req.params.id);

      const event = await storage.getClashEvent(eventId);
      if (!event) return res.status(404).json({ error: "Event not found" });
      if (event.createdBy !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Not authorized" });
      }
      if (event.status === "completed" || event.status === "cancelled") {
        return res.status(400).json({ error: "Event is already finished" });
      }

      const updated = await storage.updateClashEvent(eventId, {
        status: "cancelled",
        completedAt: new Date(),
      });
      res.json(updated);
    } catch (error) {
      console.error("Error cancelling clash event:", error);
      res.status(500).json({ error: "Failed to cancel event" });
    }
  });

  // ==================== CLASH RUNNER ISSUED TOKENS (admin) ====================

  // List all clash runner issued tokens
  app.get("/api/admin/clash-runner-tokens", requireAuth, requireAdmin, async (req, res) => {
    try {
      const tokens = await storage.getAllClashRunnerIssuedTokens();
      res.json(tokens.map(t => ({
        id: t.id,
        name: t.name,
        region: t.region,
        isRevoked: t.isRevoked,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
      })));
    } catch (error) {
      console.error("Error fetching clash runner tokens:", error);
      res.status(500).json({ error: "Failed to fetch clash runner tokens" });
    }
  });

  // Create clash runner token (admin only)
  app.post("/api/admin/clash-runner-tokens", requireAuth, requireAdmin, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { name, region } = req.body;
      if (!name || !region) return res.status(400).json({ error: "Name and region required" });
      if (!["na", "apac", "eu"].includes(region)) return res.status(400).json({ error: "Invalid region" });

      const token = "cr" + generateSecureToken(15);
      const tokenHash = hashToken(token);

      const issued = await storage.createClashRunnerIssuedToken({
        name,
        tokenHash,
        region,
        createdBy: user.id,
        isRevoked: false,
      });

      res.json({ id: issued.id, name: issued.name, token, region: issued.region, createdAt: issued.createdAt });
    } catch (error) {
      console.error("Error creating clash runner token:", error);
      res.status(500).json({ error: "Failed to create clash runner token" });
    }
  });

  // Revoke clash runner token (admin only)
  app.post("/api/admin/clash-runner-tokens/:id/revoke", requireAuth, requireAdmin, async (req, res) => {
    try {
      await storage.revokeClashRunnerIssuedToken(parseInt(req.params.id));
      res.json({ message: "Clash runner token revoked" });
    } catch (error) {
      console.error("Error revoking clash runner token:", error);
      res.status(500).json({ error: "Failed to revoke clash runner token" });
    }
  });

  // List all registered clash runners (admin + principal/fellow)
  app.get("/api/admin/clash-runners", requireAuth, async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    const isScout = user.isAdmin || user.plan === "principal" || user.plan === "fellow";
    if (!isScout) return res.status(403).json({ error: "Not authorized" });
    try {
      const runners = await storage.getAllClashRunners();
      res.json(runners.map(r => ({
        id: r.id,
        runnerId: r.runnerId,
        region: r.region,
        state: r.state,
        currentMatchId: r.currentMatchId,
        lastHeartbeatAt: r.lastHeartbeatAt,
        createdAt: r.createdAt,
      })));
    } catch (error) {
      console.error("Error listing clash runners:", error);
      res.status(500).json({ error: "Failed to list clash runners" });
    }
  });

  // ==================== CLASH RUNNER POOL (v2) ====================

  // Runner joins pool — validates against admin-issued tokens
  app.post("/api/clash-runner/register", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Bearer token required" });
      }
      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);

      const issuedToken = await storage.getClashRunnerIssuedTokenByHash(tokenHash);
      if (!issuedToken || issuedToken.isRevoked) {
        return res.status(401).json({ error: "Invalid or revoked runner token" });
      }

      const { runnerId } = req.body;
      if (!runnerId) return res.status(400).json({ error: "runnerId is required" });

      const runner = await storage.registerClashRunner({ runnerId, tokenHash, region: issuedToken.region });
      await storage.updateClashRunnerIssuedTokenLastUsed(issuedToken.id);
      res.json({ id: runner.id, state: runner.state, region: runner.region });
    } catch (error) {
      console.error("Error registering clash runner:", error);
      res.status(500).json({ error: "Failed to register runner" });
    }
  });

  // Shared auth helper: validate Bearer token, check revocation, return runner
  async function authenticateClashRunner(req: any, res: any): Promise<Awaited<ReturnType<typeof storage.getClashRunnerByTokenHash>> | null> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Bearer token required" });
      return null;
    }
    const token = authHeader.slice(7);
    const tokenHash = hashToken(token);

    // Check issued token is valid and not revoked
    const issuedToken = await storage.getClashRunnerIssuedTokenByHash(tokenHash);
    if (!issuedToken || issuedToken.isRevoked) {
      res.status(401).json({ error: "Invalid or revoked runner token" });
      return null;
    }

    // Look up the registered runner
    const runner = await storage.getClashRunnerByTokenHash(tokenHash);
    if (!runner) {
      res.status(401).json({ error: "Unknown runner — register first" });
      return null;
    }
    return runner;
  }

  // Runner heartbeat
  app.post("/api/clash-runner/heartbeat", async (req, res) => {
    try {
      const runner = await authenticateClashRunner(req, res);
      if (!runner) return;

      await storage.updateClashRunner(runner.id, { lastHeartbeatAt: new Date() });
      res.json({ state: runner.state, currentMatchId: runner.currentMatchId });
    } catch (error) {
      console.error("Error in clash runner heartbeat:", error);
      res.status(500).json({ error: "Failed to process heartbeat" });
    }
  });

  // Get assigned match config
  app.get("/api/clash-runner/assignment", async (req, res) => {
    try {
      const runner = await authenticateClashRunner(req, res);
      if (!runner) return;

      if (runner.state !== "assigned" || !runner.currentMatchId) {
        return res.json({ assigned: false });
      }

      const match = await storage.getClashMatch(runner.currentMatchId);
      if (!match) return res.json({ assigned: false });

      const event = await storage.getClashEvent(match.eventId);
      if (!event) return res.json({ assigned: false });

      const profileA = await storage.getClashAgentProfile(match.agentAProfileId);
      const profileB = await storage.getClashAgentProfile(match.agentBProfileId);
      if (!profileA || !profileB) {
        return res.status(500).json({ error: "Agent profile(s) missing" });
      }

      // Build Agora config if configured
      // UIDs <= 10,000 reserved for internal system use (broadcasters, moderators)
      const BROADCASTER_UID_A = 100;  // Agent A audio
      const BROADCASTER_UID_B = 200;  // Agent B audio
      const RECEIVER_UID = 300;       // RTC audio → PipeWire (moderator voice to agents)
      let agora: {
        appId: string; channelName: string;
        broadcasterTokenA: string; broadcasterTokenB: string;
        broadcasterUidA: number; broadcasterUidB: number;
        receiverToken: string; receiverUid: number;
      } | undefined;
      const channelName = event.agoraChannelName;
      if (isAgoraConfigured() && channelName) {
        agora = {
          appId: process.env.AGORA_APP_ID!,
          channelName,
          broadcasterTokenA: generateRtcToken(channelName, BROADCASTER_UID_A, "publisher"),
          broadcasterTokenB: generateRtcToken(channelName, BROADCASTER_UID_B, "publisher"),
          broadcasterUidA: BROADCASTER_UID_A,
          broadcasterUidB: BROADCASTER_UID_B,
          receiverToken: generateRtcToken(channelName, RECEIVER_UID, "audience"),
          receiverUid: RECEIVER_UID,
        };
      }

      // Transition runner → running (match already set to "starting" by scheduler)
      await storage.updateClashRunner(runner.id, { state: "running" });

      res.json({
        assigned: true,
        match: {
          id: match.id,
          topic: match.topic,
          region: event.region,
          maxDurationSeconds: match.maxDurationSeconds,
          config: match.config,
        },
        event: {
          id: event.id,
          name: event.name,
          region: event.region,
        },
        agentA: {
          id: profileA.id,
          name: profileA.name,
          agentUrl: profileA.agentUrl,
          setupSteps: profileA.setupSteps,
        },
        agentB: {
          id: profileB.id,
          name: profileB.name,
          agentUrl: profileB.agentUrl,
          setupSteps: profileB.setupSteps,
        },
        agora,
      });
    } catch (error) {
      console.error("Error getting clash runner assignment:", error);
      res.status(500).json({ error: "Failed to get assignment" });
    }
  });

  // Fetch decrypted secrets for an active match (runner Bearer auth)
  app.get("/api/clash-runner/secrets", async (req, res) => {
    try {
      const runner = await authenticateClashRunner(req, res);
      if (!runner) return;

      const matchId = parseInt(req.query.matchId as string);
      if (!matchId) return res.status(400).json({ error: "matchId query parameter required" });

      // Verify the runner is actively running this match
      if (runner.state !== "running" || runner.currentMatchId !== matchId) {
        return res.status(403).json({ error: "Secrets only available for your active match" });
      }

      const match = await storage.getClashMatch(matchId);
      if (!match) return res.status(404).json({ error: "Match not found" });

      const event = await storage.getClashEvent(match.eventId);
      if (!event) return res.status(404).json({ error: "Event not found" });

      // Fetch and decrypt event owner's secrets
      const userSecrets = await storage.getSecretsByUserId(event.createdBy);
      const decrypted: Record<string, string> = {};
      let decryptErrors = 0;
      for (const s of userSecrets) {
        try {
          decrypted[s.name] = decryptValue(s.encryptedValue);
        } catch {
          decryptErrors++;
        }
      }

      console.log(`[ClashSecrets] Runner ${runner.runnerId} fetched secrets for match #${matchId} (event #${event.id}, owner #${event.createdBy}): ${Object.keys(decrypted).length} decrypted, ${decryptErrors} failed`);

      res.json(decrypted);
    } catch (error) {
      console.error("Error fetching clash runner secrets:", error);
      res.status(500).json({ error: "Failed to fetch secrets" });
    }
  });

  // Runner reports results and returns to idle
  app.post("/api/clash-runner/complete", async (req, res) => {
    try {
      const runner = await authenticateClashRunner(req, res);
      if (!runner) return;

      const { matchId, metricsA, metricsB, recordingUrl, durationSeconds, error: matchError } = req.body;
      if (!matchId) return res.status(400).json({ error: "matchId required" });

      const match = await storage.getClashMatch(matchId);
      if (!match) return res.status(404).json({ error: "Match not found" });

      const profileA = await storage.getClashAgentProfile(match.agentAProfileId);
      const profileB = await storage.getClashAgentProfile(match.agentBProfileId);

      // Store results for each agent
      if (metricsA) {
        await storage.createClashResult({
          clashMatchId: matchId,
          agentProfileId: match.agentAProfileId,
          providerId: profileA?.providerId || null,
          ...metricsA,
        });
      }
      if (metricsB) {
        await storage.createClashResult({
          clashMatchId: matchId,
          agentProfileId: match.agentBProfileId,
          providerId: profileB?.providerId || null,
          ...metricsB,
        });
      }

      // Determine winner
      let winnerId: number | null = null;
      if (!matchError && metricsA && metricsB) {
        const latA = metricsA.responseLatencyMedian;
        const latB = metricsB.responseLatencyMedian;
        if (latA != null && latB != null && latA > 0 && latB > 0) {
          const ratio = latA / latB;
          if (ratio < 0.9) {
            winnerId = match.agentAProfileId;
          } else if (ratio > 1.1) {
            winnerId = match.agentBProfileId;
          }
          // else draw: winnerId stays null
        }
      }

      // Update match as completed
      await storage.updateClashMatch(matchId, {
        status: matchError ? "failed" : "completed",
        completedAt: new Date(),
        recordingUrl: recordingUrl || null,
        durationSeconds: durationSeconds || null,
        error: matchError || null,
        winnerId,
      });

      // Calculate Elo ratings if completed successfully with metrics
      if (!matchError && metricsA && metricsB) {
        await updateClashEloRatings(match.agentAProfileId, match.agentBProfileId, metricsA, metricsB);
      }

      // Return runner to idle
      await storage.updateClashRunner(runner.id, { state: "idle", currentMatchId: null });

      // Check if event has more pending matches; if all done, complete event
      const eventMatches = await storage.getClashMatchesByEvent(match.eventId);
      const allDone = eventMatches.every(m => m.status === "completed" || m.status === "failed");
      if (allDone) {
        await storage.updateClashEvent(match.eventId, {
          status: "completed",
          completedAt: new Date(),
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error in clash runner complete:", error);
      res.status(500).json({ error: "Failed to complete match" });
    }
  });

  // ==================== CLASH PUBLIC FEED & MATCH DETAIL ====================

  // Public feed: live + upcoming + recent events
  app.get("/api/clash/feed", async (req, res) => {
    try {
      const events = await storage.getClashEventFeed();
      res.json(events);
    } catch (error) {
      console.error("Error getting clash feed:", error);
      res.status(500).json({ error: "Failed to get feed" });
    }
  });

  // Match detail + results
  app.get("/api/clash/matches/:id", async (req, res) => {
    try {
      const matchId = parseInt(req.params.id);
      const match = await storage.getClashMatch(matchId);
      if (!match) return res.status(404).json({ error: "Match not found" });

      const profileA = await storage.getClashAgentProfile(match.agentAProfileId);
      const profileB = await storage.getClashAgentProfile(match.agentBProfileId);
      const results = await storage.getClashResultsByMatch(matchId);

      res.json({
        ...match,
        agentA: profileA ? { id: profileA.id, name: profileA.name, providerId: profileA.providerId } : null,
        agentB: profileB ? { id: profileB.id, name: profileB.name, providerId: profileB.providerId } : null,
        results,
      });
    } catch (error) {
      console.error("Error getting clash match detail:", error);
      res.status(500).json({ error: "Failed to get match" });
    }
  });

  // Agora RTC token for spectator (uses event's agoraChannelName)
  app.get("/api/clash/matches/:id/stream-info", async (req, res) => {
    try {
      const matchId = parseInt(req.params.id);
      const match = await storage.getClashMatch(matchId);
      if (!match) return res.status(404).json({ error: "Match not found" });
      if (match.status !== "live" && match.status !== "starting") {
        return res.status(400).json({ error: "Match is not live" });
      }

      // Look up event's agoraChannelName
      const event = await storage.getClashEvent(match.eventId);
      const channelName = event?.agoraChannelName || null;

      if (isAgoraConfigured() && channelName) {
        // Stable spectator UID: derived from user ID (logged in) or IP (anonymous)
        const user = await getCurrentUser(req);
        const identity = user ? `user:${user.id}` : `ip:${req.ip || req.headers["x-forwarded-for"] || "anon"}`;
        const uidHash = hashToken(`spectator:${identity}:${matchId}`);
        const spectatorUid = (parseInt(uidHash.slice(0, 8), 16) % 100000) + 10001;
        const spectatorToken = generateRtcToken(channelName, spectatorUid, "audience");
        return res.json({
          appId: process.env.AGORA_APP_ID,
          channelId: channelName,
          token: spectatorToken,
          uid: spectatorUid,
        });
      }

      // Fallback: no Agora configured
      res.json({
        channelId: channelName,
        matchId: match.id,
        topic: match.topic,
      });
    } catch (error) {
      console.error("Error getting stream info:", error);
      res.status(500).json({ error: "Failed to get stream info" });
    }
  });

  // Transcript for match
  app.get("/api/clash/matches/:id/transcript", async (req, res) => {
    try {
      const matchId = parseInt(req.params.id);
      const transcript = await storage.getClashTranscriptsByMatch(matchId);
      res.json(transcript);
    } catch (error) {
      console.error("Error getting clash transcript:", error);
      res.status(500).json({ error: "Failed to get transcript" });
    }
  });

  // Clash leaderboard (Elo rankings)
  app.get("/api/clash/leaderboard", async (req, res) => {
    try {
      const leaderboard = await storage.getClashLeaderboard();
      res.json(leaderboard);
    } catch (error) {
      console.error("Error getting clash leaderboard:", error);
      res.status(500).json({ error: "Failed to get leaderboard" });
    }
  });

  // --- Moderator Lifecycle (runner-to-server callbacks) ---

  app.post("/api/clash/moderator/start", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Runner token required" });
      }
      const { matchId } = req.body;
      if (!matchId) return res.status(400).json({ error: "matchId required" });

      if (!isModeratorConfigured()) {
        return res.json({ success: true, moderatorAvailable: false });
      }

      const match = await storage.getClashMatch(matchId);
      if (!match) return res.status(404).json({ error: "Match not found" });

      const event = await storage.getClashEvent(match.eventId);
      if (!event) return res.status(404).json({ error: "Event not found" });

      const profileA = await storage.getClashAgentProfile(match.agentAProfileId);
      const profileB = await storage.getClashAgentProfile(match.agentBProfileId);
      if (!profileA || !profileB) return res.status(500).json({ error: "Agent profile(s) missing" });

      const channelName = event.agoraChannelName || generateEventChannelName(event.id);
      const modUid = 500;  // Fixed moderator UID (reserved range <= 10,000)
      const modToken = generateRtcToken(channelName, modUid, "publisher");

      const prompt = buildAnnouncementPrompt(
        profileA.name,
        profileB.name,
        match.topic,
        match.maxDurationSeconds,
      );

      const agentId = await startModerator({
        channelName,
        token: modToken,
        uid: String(modUid),
        systemPrompt: prompt.systemPrompt,
        greetingMessage: prompt.greetingMessage,
      });

      await storage.updateClashEvent(event.id, {
        moderatorAgentId: agentId,
        agoraChannelName: channelName,
      });

      res.json({ success: true, agentId, moderatorAvailable: true });
    } catch (error) {
      console.error("Error starting moderator:", error);
      res.status(500).json({ error: "Failed to start moderator" });
    }
  });

  app.post("/api/clash/moderator/announce", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Runner token required" });
      }
      const { matchId, phase } = req.body;
      if (!matchId || !phase) return res.status(400).json({ error: "matchId and phase required" });

      const match = await storage.getClashMatch(matchId);
      if (!match) return res.json({ success: true, skipped: true });

      const event = await storage.getClashEvent(match.eventId);
      if (!event || !event.moderatorAgentId) {
        return res.json({ success: true, skipped: true });
      }

      const profileA = await storage.getClashAgentProfile(match.agentAProfileId);
      const profileB = await storage.getClashAgentProfile(match.agentBProfileId);
      if (!profileA || !profileB) return res.status(500).json({ error: "Agent profile(s) missing" });

      let prompt: { systemPrompt: string; greetingMessage: string };
      switch (phase) {
        case "brief_a":
          prompt = buildBriefingPrompt(profileA.name, profileB.name, match.topic);
          break;
        case "brief_b":
          prompt = buildBriefingPrompt(profileB.name, profileA.name, match.topic);
          break;
        case "start":
          prompt = buildStartPrompt();
          break;
        case "end":
          prompt = buildEndPrompt("The debate has concluded.");
          break;
        default:
          return res.status(400).json({ error: `Unknown phase: ${phase}` });
      }

      await speakModerator(event.moderatorAgentId, prompt.greetingMessage, "INTERRUPT", false);
      res.json({ success: true });
    } catch (error) {
      console.error("Error in moderator speak:", error);
      res.status(500).json({ error: "Failed to speak" });
    }
  });

  app.post("/api/clash/moderator/stop", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Runner token required" });
      }
      const { matchId } = req.body;
      if (!matchId) return res.status(400).json({ error: "matchId required" });

      const match = await storage.getClashMatch(matchId);
      if (!match) return res.json({ success: true });

      const event = await storage.getClashEvent(match.eventId);
      if (!event || !event.moderatorAgentId) {
        return res.json({ success: true });
      }

      await stopModerator(event.moderatorAgentId);
      await storage.updateClashEvent(event.id, { moderatorAgentId: null });
      res.json({ success: true });
    } catch (error) {
      console.error("Error stopping moderator:", error);
      res.status(500).json({ error: "Failed to stop moderator" });
    }
  });

  // --- Clash Schedules (Scout/Principal users) ---

  app.get("/api/clash/schedules", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const schedules = await storage.getClashSchedulesByUser(user.id);
      res.json(schedules);
    } catch (error) {
      console.error("Error listing clash schedules:", error);
      res.status(500).json({ error: "Failed to list schedules" });
    }
  });

  app.post("/api/clash/schedules", requirePrincipal, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { eventName, region, matchups, maxDurationSeconds, scheduledAt, cronExpression } = req.body;
      if (!eventName || !region || !matchups || !Array.isArray(matchups) || matchups.length === 0) {
        return res.status(400).json({ error: "eventName, region, and matchups array are required" });
      }

      // Validate cron if provided
      if (cronExpression) {
        const nextRun = parseNextCronRun(cronExpression);
        if (!nextRun) {
          return res.status(400).json({ error: "Invalid cron expression" });
        }
      }

      const schedule = await storage.createClashSchedule({
        eventName,
        createdBy: user.id,
        matchups,
        region,
        maxDurationSeconds: maxDurationSeconds || 300,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        cronExpression: cronExpression || null,
        isEnabled: true,
      });

      res.status(201).json(schedule);
    } catch (error) {
      console.error("Error creating clash schedule:", error);
      res.status(500).json({ error: "Failed to create schedule" });
    }
  });

  app.patch("/api/clash/schedules/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const scheduleId = parseInt(req.params.id);

      const schedule = await storage.getClashSchedule(scheduleId);
      if (!schedule) return res.status(404).json({ error: "Schedule not found" });
      if (!canEditResource(user, schedule)) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const { eventName, isEnabled, scheduledAt, cronExpression, matchups, maxDurationSeconds } = req.body;
      const updates: Record<string, unknown> = {};
      if (eventName !== undefined) updates.eventName = eventName;
      if (isEnabled !== undefined) updates.isEnabled = isEnabled;
      if (scheduledAt !== undefined) updates.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
      if (cronExpression !== undefined) {
        if (cronExpression) {
          const nextRun = parseNextCronRun(cronExpression);
          if (!nextRun) return res.status(400).json({ error: "Invalid cron expression" });
        }
        updates.cronExpression = cronExpression || null;
      }
      if (matchups !== undefined) updates.matchups = matchups;
      if (maxDurationSeconds !== undefined) updates.maxDurationSeconds = maxDurationSeconds;

      const updated = await storage.updateClashSchedule(scheduleId, updates as any);
      res.json(updated);
    } catch (error) {
      console.error("Error updating clash schedule:", error);
      res.status(500).json({ error: "Failed to update schedule" });
    }
  });

  app.delete("/api/clash/schedules/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const scheduleId = parseInt(req.params.id);

      const schedule = await storage.getClashSchedule(scheduleId);
      if (!schedule) return res.status(404).json({ error: "Schedule not found" });
      if (!canEditResource(user, schedule)) {
        return res.status(403).json({ error: "Not authorized" });
      }

      await storage.deleteClashSchedule(scheduleId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting clash schedule:", error);
      res.status(500).json({ error: "Failed to delete schedule" });
    }
  });

  // --- Match Scheduler: assign pending matches to idle runners (every 10s) ---
  setInterval(async () => {
    try {
      // Mark stale runners as draining (no heartbeat for >45s)
      await storage.markStaleRunnersDraining();

      // Clean up runners that have been draining for >1 hour
      await storage.removeStaleRunners(3600_000);

      // Fail matches stuck in "starting" for >5 minutes (runner likely crashed)
      await storage.failStuckMatches(300_000);

      // Check live events for pending matches to assign
      const liveEvents = await storage.getClashEventsByStatus("live");
      for (const event of liveEvents) {
        try {
          const matches = await storage.getClashMatchesByEvent(event.id);

          // Skip if there's already a live or starting match
          const hasActive = matches.some(m => m.status === "live" || m.status === "starting");
          if (hasActive) continue;

          // Find the next pending match
          const pending = matches.find(m => m.status === "pending");
          if (!pending) continue;

          // Find an idle runner in the event's region
          const runner = await storage.getIdleClashRunner(event.region);
          if (!runner) continue;

          // Assign match to runner atomically — mark both in one scheduler tick
          // so the next tick sees the match as "starting" and won't double-assign
          await storage.updateClashMatch(pending.id, {
            status: "starting",
            runnerId: runner.runnerId,
            startedAt: new Date(),
          });
          await storage.updateClashRunner(runner.id, {
            state: "assigned",
            currentMatchId: pending.id,
          });

          console.log(`[ClashMatchScheduler] Assigned match #${pending.id} to runner ${runner.runnerId}`);
        } catch (err) {
          console.error(`[ClashMatchScheduler] Error processing event ${event.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[ClashMatchScheduler] Error:", err);
    }
  }, 10_000);

  // --- Schedule Cron: create events from due schedules (every 60s) ---
  setInterval(async () => {
    try {
      const dueSchedules = await storage.getDueClashSchedules();
      for (const schedule of dueSchedules) {
        try {
          const matchupsData = schedule.matchups as Array<{
            agentAProfileId: number;
            agentBProfileId: number;
            topic: string;
            maxDurationSeconds?: number;
          }>;

          // Create event
          const event = await storage.createClashEvent({
            name: schedule.eventName,
            description: null,
            createdBy: schedule.createdBy,
            region: schedule.region,
            status: "live",
            visibility: "public",
            scheduledAt: null,
            agoraChannelName: null,
            moderatorAgentId: null,
          });

          // Set Agora channel name for event
          if (isAgoraConfigured()) {
            const channelName = generateEventChannelName(event.id);
            await storage.updateClashEvent(event.id, { agoraChannelName: channelName, startedAt: new Date() });
          } else {
            await storage.updateClashEvent(event.id, { startedAt: new Date() });
          }

          // Create match rows from matchups
          for (let i = 0; i < matchupsData.length; i++) {
            const m = matchupsData[i];
            await storage.createClashMatch({
              eventId: event.id,
              matchOrder: i + 1,
              agentAProfileId: m.agentAProfileId,
              agentBProfileId: m.agentBProfileId,
              topic: m.topic || "Freestyle debate",
              maxDurationSeconds: m.maxDurationSeconds || schedule.maxDurationSeconds,
              config: {},
              status: "pending",
              runnerId: null,
              recordingUrl: null,
              durationSeconds: null,
              error: null,
            });
          }

          // Update schedule: set lastRunAt, handle one-time vs recurring
          if (schedule.cronExpression) {
            const nextRun = parseNextCronRun(schedule.cronExpression);
            await storage.updateClashSchedule(schedule.id, {
              lastRunAt: new Date(),
              scheduledAt: nextRun || null,
            } as any);
          } else {
            // One-time schedule: disable after running
            await storage.updateClashSchedule(schedule.id, {
              lastRunAt: new Date(),
              isEnabled: false,
            } as any);
          }

          console.log(`[ClashScheduler] Created event #${event.id} from schedule "${schedule.eventName}"`);
        } catch (err) {
          console.error(`[ClashScheduler] Error processing schedule ${schedule.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[ClashScheduler] Error checking schedules:", err);
    }
  }, 60_000);

  // ==================== API V1 ROUTES ====================
  registerApiV1Routes(app);

  // ==================== API DOCUMENTATION ====================
  // Serve OpenAPI spec as JSON
  app.get("/api/v1/openapi.json", async (req, res) => {
    try {
      const fs = await import("fs");
      const yaml = await import("js-yaml");
      const path = await import("path");

      const specPath = path.join(process.cwd(), "docs", "openapi.yaml");
      const specContent = fs.readFileSync(specPath, "utf-8");
      const spec = yaml.load(specContent);

      res.json(spec);
    } catch (error) {
      console.error("Error loading OpenAPI spec:", error);
      res.status(500).json({ error: "Failed to load API documentation" });
    }
  });

  // Serve Swagger UI
  app.get("/api/docs", async (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Vox API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/api/v1/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>
    `;
    res.type("html").send(html);
  });

  return httpServer;
}
