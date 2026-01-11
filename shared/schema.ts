import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, timestamp, serial, boolean, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const userPlanEnum = pgEnum("user_plan", ["basic", "premium", "principal"]);
export const visibilityEnum = pgEnum("visibility", ["public", "private"]);
export const regionEnum = pgEnum("region", ["na", "apac", "eu"]);
export const vendorTypeEnum = pgEnum("vendor_type", ["livekit_agent", "agora_convoai"]);
export const jobStatusEnum = pgEnum("job_status", ["pending", "running", "completed", "failed"]);
export const workerStatusEnum = pgEnum("worker_status", ["online", "offline", "busy"]);

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  plan: userPlanEnum("plan").default("basic").notNull(),
  isAdmin: boolean("is_admin").default(false).notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  emailVerifiedAt: timestamp("email_verified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const inviteTokens = pgTable("invite_tokens", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  plan: userPlanEnum("plan").default("basic").notNull(),
  isAdmin: boolean("is_admin").default(false).notNull(),
  token: text("token").notNull().unique(),
  createdBy: varchar("created_by").references(() => users.id),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const activationTokens = pgTable("activation_tokens", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const workflows = pgTable("workflows", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: varchar("owner_id").notNull().references(() => users.id),
  visibility: visibilityEnum("visibility").default("public").notNull(),
  isMainline: boolean("is_mainline").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertWorkflowSchema = createInsertSchema(workflows).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWorkflow = z.infer<typeof insertWorkflowSchema>;
export type Workflow = typeof workflows.$inferSelect;

export const testSets = pgTable("test_sets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: varchar("owner_id").notNull().references(() => users.id),
  visibility: visibilityEnum("visibility").default("public").notNull(),
  isMainline: boolean("is_mainline").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTestSetSchema = createInsertSchema(testSets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTestSet = z.infer<typeof insertTestSetSchema>;
export type TestSet = typeof testSets.$inferSelect;

export const benchmarkResults = pgTable("benchmark_results", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull(),
  region: text("region").notNull(),
  responseLatency: integer("response_latency").notNull(),
  interruptLatency: integer("interrupt_latency").notNull(),
  networkResilience: integer("network_resilience").notNull(),
  naturalness: real("naturalness").notNull(),
  noiseReduction: integer("noise_reduction").notNull(),
  workflowId: integer("workflow_id").references(() => workflows.id),
  testSetId: integer("test_set_id").references(() => testSets.id),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

export const insertBenchmarkResultSchema = createInsertSchema(benchmarkResults).omit({
  id: true,
  timestamp: true,
});

export type InsertBenchmarkResult = z.infer<typeof insertBenchmarkResultSchema>;
export type BenchmarkResult = typeof benchmarkResults.$inferSelect;

export const systemConfig = pgTable("system_config", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
});

export const insertSystemConfigSchema = createInsertSchema(systemConfig).omit({
  id: true,
});

export type InsertSystemConfig = z.infer<typeof insertSystemConfigSchema>;
export type SystemConfig = typeof systemConfig.$inferSelect;

// Vendor configurations for workflows
export const vendors = pgTable("vendors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: vendorTypeEnum("type").notNull(),
  config: jsonb("config").notNull().default({}),
  workflowId: integer("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertVendorSchema = createInsertSchema(vendors).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type Vendor = typeof vendors.$inferSelect;

// Test cases within workflows
export const testCases = pgTable("test_cases", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  workflowId: integer("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  region: regionEnum("region").notNull(),
  config: jsonb("config").notNull().default({}),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTestCaseSchema = createInsertSchema(testCases).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTestCase = z.infer<typeof insertTestCaseSchema>;
export type TestCase = typeof testCases.$inferSelect;

// Worker tokens created by admin for worker registration
export const workerTokens = pgTable("worker_tokens", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  token: text("token").notNull().unique(),
  region: regionEnum("region").notNull(),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  isRevoked: boolean("is_revoked").default(false).notNull(),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertWorkerTokenSchema = createInsertSchema(workerTokens).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
});

export type InsertWorkerToken = z.infer<typeof insertWorkerTokenSchema>;
export type WorkerToken = typeof workerTokens.$inferSelect;

// Registered workers
export const workers = pgTable("workers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tokenId: integer("token_id").notNull().references(() => workerTokens.id),
  region: regionEnum("region").notNull(),
  status: workerStatusEnum("status").default("offline").notNull(),
  lastHeartbeat: timestamp("last_heartbeat"),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertWorkerSchema = createInsertSchema(workers).omit({
  id: true,
  createdAt: true,
  lastHeartbeat: true,
});

export type InsertWorker = z.infer<typeof insertWorkerSchema>;
export type Worker = typeof workers.$inferSelect;

// Jobs for workers to execute
export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  testCaseId: integer("test_case_id").notNull().references(() => testCases.id, { onDelete: "cascade" }),
  workerId: integer("worker_id").references(() => workers.id),
  status: jobStatusEnum("status").default("pending").notNull(),
  region: regionEnum("region").notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertJobSchema = createInsertSchema(jobs).omit({
  id: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
});

export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobs.$inferSelect;
