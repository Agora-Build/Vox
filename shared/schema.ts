import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, timestamp, serial, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const userPlanEnum = pgEnum("user_plan", ["basic", "premium", "principal"]);
export const visibilityEnum = pgEnum("visibility", ["public", "private"]);

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
