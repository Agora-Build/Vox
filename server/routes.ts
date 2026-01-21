import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage, hashToken, generateSecureToken } from "./storage";
import { generateProviderId } from "@shared/schema";
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
} from "./auth";

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

  // ==================== PROJECT ROUTES ====================

  app.get("/api/projects", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const projects = await storage.getProjectsByOwner(user.id);
      res.json(projects);
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
        
        await storage.createEvalResult({
          evalJobId: parseInt(jobId),
          providerId: workflow?.providerId || "",
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

  // ==================== METRICS ROUTES ====================

  app.get("/api/metrics/realtime", async (req, res) => {
    try {
      const results = await storage.getMainlineEvalResults(50);
      res.json(results);
    } catch (error) {
      console.error("Error fetching realtime metrics:", error);
      res.status(500).json({ error: "Failed to fetch metrics" });
    }
  });

  app.get("/api/metrics/leaderboard", async (req, res) => {
    try {
      const results = await storage.getMainlineEvalResults(1000);
      
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

  return httpServer;
}
