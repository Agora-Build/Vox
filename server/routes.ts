import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage, db } from "./storage";
import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import { benchmarkResults, systemConfig } from "@shared/schema";
import { count } from "drizzle-orm";
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
        passwordHash: await hashPassword(generateToken()),
        plan: "principal",
        isAdmin: false,
        isEnabled: true,
        emailVerifiedAt: new Date(),
      });

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
      
      const updates: any = {};
      if (typeof isEnabled === "boolean") updates.isEnabled = isEnabled;
      if (typeof isAdmin === "boolean") updates.isAdmin = isAdmin;
      if (plan && ["basic", "premium", "principal"].includes(plan)) updates.plan = plan;
      
      const updated = await storage.updateUser(id, updates);
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
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      
      await storage.createInviteToken(
        email, 
        plan || "basic", 
        isAdmin || false, 
        token, 
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

  app.post("/api/auth/register", async (req, res) => {
    try {
      const { token, username, password } = req.body;
      
      if (!token || !username || !password) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const invite = await storage.getInviteToken(token);
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

      const passwordHash = await hashPassword(password);
      
      const user = await storage.createUser({
        username,
        email: invite.email,
        passwordHash,
        plan: invite.plan as "basic" | "premium" | "principal",
        isAdmin: invite.isAdmin,
        isEnabled: true,
        emailVerifiedAt: new Date(),
      });

      await storage.markInviteTokenUsed(token);

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

  app.get("/api/workflows", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      const workflows = await storage.getWorkflows(user?.id);
      res.json(workflows);
    } catch (error) {
      console.error("Error fetching workflows:", error);
      res.status(500).json({ error: "Failed to fetch workflows" });
    }
  });

  app.post("/api/workflows", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { name, description, visibility } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Name required" });
      }

      if (visibility === "private" && user.plan === "basic") {
        return res.status(403).json({ error: "Premium plan required for private workflows" });
      }

      const workflow = await storage.createWorkflow({
        name,
        description,
        ownerId: user.id,
        visibility: visibility || "public",
        isMainline: false,
      });

      res.json(workflow);
    } catch (error) {
      console.error("Error creating workflow:", error);
      res.status(500).json({ error: "Failed to create workflow" });
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

  app.get("/api/test-sets", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      const testSets = await storage.getTestSets(user?.id);
      res.json(testSets);
    } catch (error) {
      console.error("Error fetching test sets:", error);
      res.status(500).json({ error: "Failed to fetch test sets" });
    }
  });

  app.post("/api/test-sets", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { name, description, visibility } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Name required" });
      }

      if (visibility === "private" && user.plan === "basic") {
        return res.status(403).json({ error: "Premium plan required for private test sets" });
      }

      const testSet = await storage.createTestSet({
        name,
        description,
        ownerId: user.id,
        visibility: visibility || "public",
        isMainline: false,
      });

      res.json(testSet);
    } catch (error) {
      console.error("Error creating test set:", error);
      res.status(500).json({ error: "Failed to create test set" });
    }
  });

  app.patch("/api/test-sets/:id/mainline", requireAuth, requirePrincipal, async (req, res) => {
    try {
      const { id } = req.params;
      const { isMainline } = req.body;
      
      const testSet = await storage.getTestSet(parseInt(id));
      if (!testSet) {
        return res.status(404).json({ error: "Test set not found" });
      }

      if (isMainline && testSet.visibility === "private") {
        return res.status(400).json({ error: "Mainline test sets must be public" });
      }

      const updated = await storage.updateTestSet(parseInt(id), { 
        isMainline,
        visibility: isMainline ? "public" : testSet.visibility,
      });
      
      res.json(updated);
    } catch (error) {
      console.error("Error updating test set mainline:", error);
      res.status(500).json({ error: "Failed to update test set" });
    }
  });

  app.get("/api/metrics/realtime", async (req, res) => {
    try {
      const results = await storage.getBenchmarkResults(50);
      res.json(results);
    } catch (error) {
      console.error("Error fetching realtime metrics:", error);
      res.status(500).json({ error: "Failed to fetch metrics" });
    }
  });

  app.get("/api/metrics/leaderboard", async (req, res) => {
    try {
      const results = await storage.getLeaderboardData();
      
      const providerRegionMap = new Map<string, { 
        provider: string; 
        region: string; 
        responseLatencies: number[]; 
        interruptLatencies: number[];
        networkResiliences: number[];
        naturalnesses: number[];
        noiseReductions: number[];
      }>();
      
      for (const result of results) {
        const key = `${result.provider}-${result.region}`;
        if (!providerRegionMap.has(key)) {
          providerRegionMap.set(key, {
            provider: result.provider,
            region: result.region,
            responseLatencies: [],
            interruptLatencies: [],
            networkResiliences: [],
            naturalnesses: [],
            noiseReductions: [],
          });
        }
        const group = providerRegionMap.get(key)!;
        group.responseLatencies.push(result.responseLatency);
        group.interruptLatencies.push(result.interruptLatency);
        group.networkResiliences.push(result.networkResilience);
        group.naturalnesses.push(result.naturalness);
        group.noiseReductions.push(result.noiseReduction);
      }
      
      const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      
      const leaderboard = Array.from(providerRegionMap.values())
        .map((group) => ({
          provider: group.provider,
          region: group.region,
          responseLatency: Math.round(avg(group.responseLatencies)),
          interruptLatency: Math.round(avg(group.interruptLatencies)),
          networkResilience: Math.round(avg(group.networkResiliences)),
          naturalness: Math.round(avg(group.naturalnesses) * 10) / 10,
          noiseReduction: Math.round(avg(group.noiseReductions)),
        }))
        .sort((a, b) => a.responseLatency - b.responseLatency)
        .map((entry, index) => ({
          rank: index + 1,
          ...entry,
        }));
      
      res.json(leaderboard);
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });

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

  app.post("/api/seed", async (req, res) => {
    try {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const seedDb = drizzle(pool);
      
      const existingCount = await seedDb.select({ count: count() }).from(benchmarkResults);
      if (existingCount[0].count > 0) {
        res.json({ message: "Database already seeded", count: existingCount[0].count });
        return;
      }
      
      await seedDb.insert(systemConfig).values([
        { key: "test_interval_hours", value: "8" },
        { key: "total_tests_24h", value: "1284" },
      ]).onConflictDoNothing();
      
      const providers = ["Agora ConvoAI", "LiveKIT Agent"];
      const regions = ["North America (East)", "Europe (Frankfurt)", "Asia (Singapore)"];
      
      const baseMetrics: Record<string, Record<string, { response: number; interrupt: number; network: number; natural: number; noise: number }>> = {
        "Agora ConvoAI": {
          "North America (East)": { response: 1180, interrupt: 450, network: 98, natural: 4.8, noise: 95 },
          "Europe (Frankfurt)": { response: 1250, interrupt: 510, network: 97, natural: 4.8, noise: 94 },
          "Asia (Singapore)": { response: 1350, interrupt: 580, network: 95, natural: 4.7, noise: 93 },
        },
        "LiveKIT Agent": {
          "North America (East)": { response: 1220, interrupt: 490, network: 96, natural: 4.7, noise: 92 },
          "Europe (Frankfurt)": { response: 1300, interrupt: 540, network: 94, natural: 4.6, noise: 90 },
          "Asia (Singapore)": { response: 1420, interrupt: 620, network: 92, natural: 4.5, noise: 89 },
        },
      };
      
      const now = new Date();
      const results = [];
      
      for (let hoursAgo = 24; hoursAgo >= 0; hoursAgo -= 1) {
        const timestamp = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        
        for (const provider of providers) {
          for (const region of regions) {
            const base = baseMetrics[provider][region];
            const variation = () => (Math.random() - 0.5) * 0.1;
            
            results.push({
              provider,
              region,
              responseLatency: Math.round(base.response * (1 + variation())),
              interruptLatency: Math.round(base.interrupt * (1 + variation())),
              networkResilience: Math.round(base.network * (1 + variation() * 0.5)),
              naturalness: Math.round((base.natural * (1 + variation() * 0.2)) * 10) / 10,
              noiseReduction: Math.round(base.noise * (1 + variation() * 0.5)),
              timestamp,
            });
          }
        }
      }
      
      await seedDb.insert(benchmarkResults).values(results);
      
      res.json({ message: "Database seeded successfully", count: results.length });
    } catch (error) {
      console.error("Error seeding database:", error);
      res.status(500).json({ error: "Failed to seed database" });
    }
  });

  return httpServer;
}
