import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage, hashToken, generateSecureToken } from "./storage";
import { parseNextCronRun } from "./cron";
import { generateProviderId } from "@shared/schema";
import { registerApiV1Routes } from "./routes-api-v1";
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
  generateApiKey,
  passport,
} from "./auth";
import { calculateSeatPrice, isStripeConfigured as isPricingStripeConfigured } from "./pricing";
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
          isOrgAdmin: user.isOrgAdmin,
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

      // Create default providers (ID is generated automatically)
      await storage.createProvider({
        name: "Agora ConvoAI Engine",
        sku: "convoai",
        description: "Agora's Conversational AI Engine",
      });

      await storage.createProvider({
        name: "LiveKit Agents",
        sku: "convoai",
        description: "LiveKit's Real-time Communication Agents",
      });

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
      const { id } = req.params;
      const project = await storage.getProject(parseInt(id));
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
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
      const workflows = await storage.getWorkflowsByOwner(user.id);
      res.json(workflows);
    } catch (error) {
      console.error("Error fetching workflows:", error);
      res.status(500).json({ error: "Failed to fetch workflows" });
    }
  });

  app.get("/api/workflows/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const workflow = await storage.getWorkflow(parseInt(id));
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
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

      const { name, description, projectId, providerId, visibility } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Name required" });
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

      const workflow = await storage.createWorkflow({
        name,
        description,
        ownerId: user.id,
        projectId,
        providerId,
        visibility: visibility || "public",
        isMainline: false,
        config: {},
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

      if (workflow.ownerId !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Not authorized to modify this workflow" });
      }

      const { name, description, visibility, config } = req.body;
      const updates: Record<string, unknown> = {};
      if (name) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (config) updates.config = config;
      if (visibility) {
        if (visibility === "private" && user.plan === "basic") {
          return res.status(403).json({ error: "Premium plan required for private workflows" });
        }
        updates.visibility = visibility;
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

      if (workflow.ownerId !== user.id) {
        return res.status(403).json({ error: "Not authorized to delete this workflow" });
      }

      await storage.deleteWorkflow(parseInt(id));
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting workflow:", error);
      res.status(500).json({ error: "Failed to delete workflow" });
    }
  });

  // ==================== EVAL SET ROUTES ====================

  app.get("/api/eval-sets", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const evalSets = await storage.getEvalSetsByOwner(user.id);
      res.json(evalSets);
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
      if (evalSet.ownerId !== user.id && evalSet.visibility !== "public") {
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

      const { name, description, visibility, config } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Name required" });
      }

      if (visibility === "private" && user.plan === "basic") {
        return res.status(403).json({ error: "Premium plan required for private eval sets" });
      }

      const evalSet = await storage.createEvalSet({
        name,
        description,
        ownerId: user.id,
        visibility: visibility || "public",
        isMainline: false,
        config: config || {},
      });

      res.json(evalSet);
    } catch (error) {
      console.error("Error creating eval set:", error);
      res.status(500).json({ error: "Failed to create eval set" });
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

  // ==================== EVAL SCHEDULE ROUTES ====================

  // List all schedules for current user
  app.get("/api/eval-schedules", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const schedules = await storage.getEvalSchedulesWithWorkflow(user.id);
      res.json(schedules);
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
      if (schedule.createdBy !== user.id && !user.isAdmin) {
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

      const { name, workflowId, evalSetId, region, scheduleType, cronExpression, timezone, runAt, maxRuns } = req.body;

      if (!name || !workflowId || !region) {
        return res.status(400).json({ error: "Name, workflowId, and region are required" });
      }

      if (!["na", "apac", "eu"].includes(region)) {
        return res.status(400).json({ error: "Invalid region. Must be na, apac, or eu" });
      }

      // Verify workflow exists and user owns it
      const workflow = await storage.getWorkflow(workflowId);
      if (!workflow) {
        return res.status(404).json({ error: "Workflow not found" });
      }
      if (workflow.ownerId !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Access denied to workflow" });
      }

      // Verify eval set if provided
      if (evalSetId) {
        const evalSet = await storage.getEvalSet(evalSetId);
        if (!evalSet) {
          return res.status(404).json({ error: "Eval set not found" });
        }
        if (evalSet.ownerId !== user.id && evalSet.visibility !== "public") {
          return res.status(403).json({ error: "Access denied to eval set" });
        }
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
        evalSetId: evalSetId || null,
        region,
        scheduleType: type,
        cronExpression: cronExpression || null,
        timezone: timezone || "UTC",
        isEnabled: true,
        nextRunAt,
        maxRuns: maxRuns || null,
        createdBy: user.id,
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
      if (schedule.createdBy !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Access denied" });
      }

      const { name, isEnabled, cronExpression, maxRuns, nextRunAt } = req.body;
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
      if (schedule.createdBy !== user.id && !user.isAdmin) {
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
      if (schedule.createdBy !== user.id && !user.isAdmin) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Create a job immediately
      const job = await storage.createEvalJob({
        scheduleId: schedule.id,
        workflowId: schedule.workflowId,
        evalSetId: schedule.evalSetId,
        region: schedule.region,
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

  // ==================== EVAL AGENT TOKEN ROUTES (Admin only) ====================

  app.get("/api/admin/eval-agent-tokens", requireAuth, requireAdmin, async (req, res) => {
    try {
      const tokens = await storage.getAllEvalAgentTokens();
      res.json(tokens.map(t => ({
        id: t.id,
        name: t.name,
        region: t.region,
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

      const { name, region } = req.body;
      
      if (!name || !region) {
        return res.status(400).json({ error: "Name and region required" });
      }

      if (!["na", "apac", "eu"].includes(region)) {
        return res.status(400).json({ error: "Invalid region. Must be na, apac, or eu" });
      }

      const token = generateSecureToken();
      const tokenHash = hashToken(token);
      
      const evalAgentToken = await storage.createEvalAgentToken({
        name,
        tokenHash,
        region,
        createdBy: user.id,
        isRevoked: false,
      });

      res.json({
        id: evalAgentToken.id,
        name: evalAgentToken.name,
        token,
        region: evalAgentToken.region,
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
      const agents = await storage.getAllEvalAgents();
      res.json(agents.map(a => ({
        id: a.id,
        name: a.name,
        region: a.region,
        state: a.state,
        lastSeenAt: a.lastSeenAt,
        lastJobAt: a.lastJobAt,
        createdAt: a.createdAt,
      })));
    } catch (error) {
      console.error("Error fetching eval agents:", error);
      res.status(500).json({ error: "Failed to fetch eval agents" });
    }
  });

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

      const { name, metadata } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Agent name required" });
      }

      await storage.updateEvalAgentTokenLastUsed(evalAgentToken.id);

      const agent = await storage.createEvalAgent({
        name,
        tokenId: evalAgentToken.id,
        region: evalAgentToken.region,
        state: "idle",
        metadata: metadata || {},
      });

      await storage.updateEvalAgentHeartbeat(agent.id);

      res.json({
        id: agent.id,
        name: agent.name,
        region: agent.region,
        state: agent.state,
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

      const { agentId, state } = req.body;
      
      if (!agentId) {
        return res.status(400).json({ error: "Agent ID required" });
      }

      const agent = await storage.getEvalAgent(agentId);
      if (!agent || agent.tokenId !== evalAgentToken.id) {
        return res.status(403).json({ error: "Agent not found or token mismatch" });
      }

      await storage.updateEvalAgentHeartbeat(agentId);
      if (state && ["idle", "offline", "occupied"].includes(state)) {
        await storage.updateEvalAgent(agentId, { state });
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

      const jobs = await storage.getPendingEvalJobsByRegion(evalAgentToken.region);
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
      const { agentId } = req.body;

      if (!agentId) {
        return res.status(400).json({ error: "Agent ID required" });
      }

      const agent = await storage.getEvalAgent(agentId);
      if (!agent || agent.tokenId !== evalAgentToken.id) {
        return res.status(403).json({ error: "Agent not found or token mismatch" });
      }

      // Check that job's region matches agent's region
      const existingJob = await storage.getEvalJob(parseInt(jobId));
      if (!existingJob) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (existingJob.region !== agent.region) {
        return res.status(403).json({ error: "Job region does not match agent region" });
      }

      const job = await storage.claimEvalJob(parseInt(jobId), agentId);
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
      const { agentId, error: jobError, results } = req.body;

      if (!agentId) {
        return res.status(400).json({ error: "Agent ID required" });
      }

      const agent = await storage.getEvalAgent(agentId);
      if (!agent || agent.tokenId !== evalAgentToken.id) {
        return res.status(403).json({ error: "Agent not found or token mismatch" });
      }

      const job = await storage.getEvalJob(parseInt(jobId));
      if (!job || job.evalAgentId !== agentId) {
        return res.status(403).json({ error: "Job not found or not assigned to this agent" });
      }

      await storage.completeEvalJob(parseInt(jobId), jobError);
      await storage.updateEvalAgent(agentId, { state: "idle" });

      if (results && !jobError) {
        const workflow = await storage.getWorkflow(job.workflowId);

        // Get providerId from workflow, or use a default provider
        let providerId = workflow?.providerId;
        if (!providerId) {
          // Find a default provider (e.g., LiveKit Agents)
          const providers = await storage.getAllProviders();
          const defaultProvider = providers.find(p => p.name.includes("LiveKit")) || providers[0];
          providerId = defaultProvider?.id || null;
        }

        if (providerId) {
          await storage.createEvalResult({
            evalJobId: parseInt(jobId),
            providerId,
            region: job.region,
            responseLatencyMedian: results.responseLatencyMedian || 0,
            responseLatencySd: results.responseLatencySd || 0,
            interruptLatencyMedian: results.interruptLatencyMedian || 0,
            interruptLatencySd: results.interruptLatencySd || 0,
            networkResilience: results.networkResilience,
            naturalness: results.naturalness,
            noiseReduction: results.noiseReduction,
            rawData: results.rawData || {},
          });
        } else {
          console.warn("No provider found, skipping eval result creation");
        }
      }

      res.json({ message: "Job completed" });
    } catch (error) {
      console.error("Error completing job:", error);
      res.status(500).json({ error: "Failed to complete job" });
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

      if (workflow.ownerId !== user.id && !user.isAdmin && user.plan !== "principal" && user.plan !== "fellow") {
        return res.status(403).json({ error: "Not authorized to run this workflow" });
      }

      if (!region || !["na", "apac", "eu"].includes(region)) {
        return res.status(400).json({ error: "Valid region required (na, apac, eu)" });
      }

      const job = await storage.createEvalJob({
        workflowId: parseInt(workflowId),
        evalSetId: evalSetId || null,
        region,
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

      const { status, region, workflowId, limit, offset } = req.query;

      const filters: {
        status?: "pending" | "running" | "completed" | "failed";
        region?: "na" | "apac" | "eu";
        workflowId?: number;
        limit?: number;
        offset?: number;
      } = {};

      if (status && ["pending", "running", "completed", "failed"].includes(status as string)) {
        filters.status = status as "pending" | "running" | "completed" | "failed";
      }
      if (region && ["na", "apac", "eu"].includes(region as string)) {
        filters.region = region as "na" | "apac" | "eu";
      }
      if (workflowId) {
        filters.workflowId = parseInt(workflowId as string);
      }
      if (limit) {
        filters.limit = parseInt(limit as string);
      }
      if (offset) {
        filters.offset = parseInt(offset as string);
      }

      const jobs = await storage.getEvalJobs(filters);

      // For non-admin users, only return jobs for workflows they own or are public
      if (!user.isAdmin) {
        const userWorkflows = await storage.getWorkflowsByOwner(user.id);
        const userWorkflowIds = new Set(userWorkflows.map(w => w.id));
        const filteredJobs = jobs.filter(job => userWorkflowIds.has(job.workflowId));
        return res.json(filteredJobs);
      }

      res.json(jobs);
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

      // Check authorization
      if (!user.isAdmin) {
        const workflow = await storage.getWorkflow(job.workflowId);
        if (!workflow || workflow.ownerId !== user.id) {
          return res.status(403).json({ error: "Not authorized to view this job" });
        }
      }

      res.json(job);
    } catch (error) {
      console.error("Error fetching eval job:", error);
      res.status(500).json({ error: "Failed to fetch eval job" });
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

      // Check authorization
      if (!user.isAdmin) {
        const workflow = await storage.getWorkflow(job.workflowId);
        if (!workflow || workflow.ownerId !== user.id) {
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

  app.get("/api/metrics/realtime", async (req, res) => {
    try {
      const { hours, limit } = req.query;
      const hoursBack = hours ? parseInt(hours as string) : undefined;
      const limitNum = limit ? parseInt(limit as string) : 50;
      const results = await storage.getMainlineEvalResults(limitNum, hoursBack);
      res.json(results);
    } catch (error) {
      console.error("Error fetching realtime metrics:", error);
      res.status(500).json({ error: "Failed to fetch metrics" });
    }
  });

  app.get("/api/metrics/leaderboard", async (req, res) => {
    try {
      const { hours } = req.query;
      const hoursBack = hours ? parseInt(hours as string) : undefined;
      const results = await storage.getMainlineEvalResults(1000, hoursBack);
      
      const providerRegionMap = new Map<string, { 
        providerId: string;
        region: string; 
        responseLatencies: number[]; 
        interruptLatencies: number[];
      }>();
      
      for (const result of results) {
        const key = `${result.providerId}-${result.region}`;
        if (!providerRegionMap.has(key)) {
          providerRegionMap.set(key, {
            providerId: result.providerId,
            region: result.region,
            responseLatencies: [],
            interruptLatencies: [],
          });
        }
        const group = providerRegionMap.get(key)!;
        group.responseLatencies.push(result.responseLatencyMedian);
        group.interruptLatencies.push(result.interruptLatencyMedian);
      }
      
      const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      
      const leaderboard = await Promise.all(
        Array.from(providerRegionMap.values()).map(async (group) => {
          const provider = await storage.getProvider(group.providerId);
          return {
            providerId: group.providerId,
            providerName: provider?.name || "Unknown",
            region: group.region,
            responseLatency: Math.round(avg(group.responseLatencies)),
            interruptLatency: Math.round(avg(group.interruptLatencies)),
          };
        })
      );
      
      const sorted = leaderboard
        .sort((a, b) => a.responseLatency - b.responseLatency)
        .map((entry, index) => ({
          rank: index + 1,
          ...entry,
        }));
      
      res.json(sorted);
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });

  // ==================== CONFIG ROUTES ====================

  app.get("/api/config", async (req, res) => {
    try {
      const configs = await storage.getAllConfig();
      const configObject: Record<string, string> = {};
      for (const config of configs) {
        configObject[config.key] = config.value;
      }
      res.json(configObject);
    } catch (error) {
      console.error("Error fetching config:", error);
      res.status(500).json({ error: "Failed to fetch config" });
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

      // Link user to organization and make them admin
      await storage.updateUser(user.id, {
        organizationId: org.id,
        isOrgAdmin: true,
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
        isOrgAdmin: m.isOrgAdmin,
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
      const { isOrgAdmin } = req.body;

      if (user.organizationId !== parseInt(id)) {
        return res.status(403).json({ error: "Not authorized to modify this organization" });
      }

      const member = await storage.getUser(parseInt(userId));
      if (!member || member.organizationId !== parseInt(id)) {
        return res.status(404).json({ error: "Member not found in organization" });
      }

      // Cannot demote yourself
      if (parseInt(userId) === user.id && isOrgAdmin === false) {
        return res.status(400).json({ error: "Cannot demote yourself" });
      }

      // Check max org admins (4)
      if (isOrgAdmin === true) {
        const adminCount = await storage.countOrgAdmins(parseInt(id));
        if (adminCount >= 4) {
          return res.status(400).json({ error: "Maximum 4 organization admins allowed" });
        }
      }

      const updated = await storage.updateUser(parseInt(userId), { isOrgAdmin });
      res.json({
        id: updated?.id,
        username: updated?.username,
        isOrgAdmin: updated?.isOrgAdmin,
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

      // Cannot remove the only org admin
      if (member.isOrgAdmin) {
        const adminCount = await storage.countOrgAdmins(parseInt(id));
        if (adminCount <= 1) {
          return res.status(400).json({ error: "Cannot remove the only organization admin" });
        }
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

      // Cannot leave if only org admin
      if (user.isOrgAdmin) {
        const adminCount = await storage.countOrgAdmins(parseInt(id));
        if (adminCount <= 1) {
          return res.status(400).json({ error: "Cannot leave as the only organization admin. Transfer admin role first." });
        }
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
        isOrgAdmin: user.isOrgAdmin,
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
