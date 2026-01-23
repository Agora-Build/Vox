import { pgTable, text, varchar, integer, real, timestamp, serial, boolean, pgEnum, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Enums
export const userPlanEnum = pgEnum("user_plan", ["basic", "premium", "principal", "fellow"]);
export const visibilityEnum = pgEnum("visibility", ["public", "private"]);
export const regionEnum = pgEnum("region", ["na", "apac", "eu"]);
export const providerSkuEnum = pgEnum("provider_sku", ["convoai", "rtc"]);
export const evalAgentStateEnum = pgEnum("eval_agent_state", ["idle", "offline", "occupied"]);
export const evalJobStatusEnum = pgEnum("eval_job_status", ["pending", "running", "completed", "failed"]);

// Helper function to generate 12-char random ID for providers
export function generateProviderId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ==================== ORGANIZATIONS ====================

export const organizations = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address"),
  verified: boolean("verified").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertOrganizationSchema = createInsertSchema(organizations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizations.$inferSelect;

// ==================== USERS ====================

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  plan: userPlanEnum("plan").default("basic").notNull(),
  isAdmin: boolean("is_admin").default(false).notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  emailVerifiedAt: timestamp("email_verified_at"),
  organizationId: integer("organization_id").references(() => organizations.id),
  isOrgAdmin: boolean("is_org_admin").default(false).notNull(),
  googleId: text("google_id").unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// ==================== PROVIDERS ====================

export const providers = pgTable("providers", {
  id: varchar("id", { length: 12 }).primaryKey(),
  name: text("name").notNull(),
  sku: providerSkuEnum("sku").notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertProviderSchema = createInsertSchema(providers).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertProvider = z.infer<typeof insertProviderSchema>;
export type Provider = typeof providers.$inferSelect;

// ==================== PROJECTS ====================

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: integer("owner_id").notNull().references(() => users.id),
  organizationId: integer("organization_id").references(() => organizations.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;

// ==================== WORKFLOWS ====================

export const workflows = pgTable("workflows", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: integer("owner_id").notNull().references(() => users.id),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  providerId: varchar("provider_id", { length: 12 }).references(() => providers.id),
  visibility: visibilityEnum("visibility").default("public").notNull(),
  isMainline: boolean("is_mainline").default(false).notNull(),
  config: jsonb("config").default({}).notNull(),
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

// ==================== EVAL SETS ====================

export const evalSets = pgTable("eval_sets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: integer("owner_id").notNull().references(() => users.id),
  visibility: visibilityEnum("visibility").default("public").notNull(),
  isMainline: boolean("is_mainline").default(false).notNull(),
  config: jsonb("config").default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertEvalSetSchema = createInsertSchema(evalSets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEvalSet = z.infer<typeof insertEvalSetSchema>;
export type EvalSet = typeof evalSets.$inferSelect;

// ==================== EVAL AGENT TOKENS ====================

export const evalAgentTokens = pgTable("eval_agent_tokens", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  region: regionEnum("region").notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  isRevoked: boolean("is_revoked").default(false).notNull(),
  expiresAt: timestamp("expires_at"),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEvalAgentTokenSchema = createInsertSchema(evalAgentTokens).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
});

export type InsertEvalAgentToken = z.infer<typeof insertEvalAgentTokenSchema>;
export type EvalAgentToken = typeof evalAgentTokens.$inferSelect;

// ==================== EVAL AGENTS ====================

export const evalAgents = pgTable("eval_agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tokenId: integer("token_id").notNull().references(() => evalAgentTokens.id),
  region: regionEnum("region").notNull(),
  state: evalAgentStateEnum("state").default("offline").notNull(),
  lastSeenAt: timestamp("last_seen_at"),
  lastJobAt: timestamp("last_job_at"),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertEvalAgentSchema = createInsertSchema(evalAgents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastSeenAt: true,
  lastJobAt: true,
});

export type InsertEvalAgent = z.infer<typeof insertEvalAgentSchema>;
export type EvalAgent = typeof evalAgents.$inferSelect;

// ==================== EVAL JOBS ====================

export const evalJobs = pgTable("eval_jobs", {
  id: serial("id").primaryKey(),
  workflowId: integer("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  evalSetId: integer("eval_set_id").references(() => evalSets.id),
  evalAgentId: integer("eval_agent_id").references(() => evalAgents.id),
  region: regionEnum("region").notNull(),
  status: evalJobStatusEnum("status").default("pending").notNull(),
  priority: integer("priority").default(0).notNull(),
  retryCount: integer("retry_count").default(0).notNull(),
  maxRetries: integer("max_retries").default(3).notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  statusRegionIdx: index("eval_jobs_status_region_idx").on(table.status, table.region),
  evalAgentIdx: index("eval_jobs_eval_agent_idx").on(table.evalAgentId),
}));

export const insertEvalJobSchema = createInsertSchema(evalJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  completedAt: true,
});

export type InsertEvalJob = z.infer<typeof insertEvalJobSchema>;
export type EvalJob = typeof evalJobs.$inferSelect;

// ==================== EVAL RESULTS ====================

export const evalResults = pgTable("eval_results", {
  id: serial("id").primaryKey(),
  evalJobId: integer("eval_job_id").notNull().references(() => evalJobs.id, { onDelete: "cascade" }),
  providerId: varchar("provider_id", { length: 12 }).notNull().references(() => providers.id),
  region: regionEnum("region").notNull(),
  responseLatencyMedian: integer("response_latency_median").notNull(),
  responseLatencySd: real("response_latency_sd").notNull(),
  interruptLatencyMedian: integer("interrupt_latency_median").notNull(),
  interruptLatencySd: real("interrupt_latency_sd").notNull(),
  networkResilience: integer("network_resilience"),
  naturalness: real("naturalness"),
  noiseReduction: integer("noise_reduction"),
  rawData: jsonb("raw_data").default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  providerRegionIdx: index("eval_results_provider_region_idx").on(table.providerId, table.region),
}));

export const insertEvalResultSchema = createInsertSchema(evalResults).omit({
  id: true,
  createdAt: true,
});

export type InsertEvalResult = z.infer<typeof insertEvalResultSchema>;
export type EvalResult = typeof evalResults.$inferSelect;

// ==================== API KEYS ====================

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: varchar("key_prefix", { length: 16 }).notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  usageCount: integer("usage_count").default(0).notNull(),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  isRevoked: boolean("is_revoked").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertApiKeySchema = createInsertSchema(apiKeys).omit({
  id: true,
  createdAt: true,
  usageCount: true,
  lastUsedAt: true,
});

export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeys.$inferSelect;

// ==================== PRICING CONFIG ====================

export const pricingConfig = pgTable("pricing_config", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  pricePerSeat: integer("price_per_seat").notNull(),
  minSeats: integer("min_seats").default(1).notNull(),
  maxSeats: integer("max_seats").default(9999).notNull(),
  discountPercent: integer("discount_percent").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPricingConfigSchema = createInsertSchema(pricingConfig).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPricingConfig = z.infer<typeof insertPricingConfigSchema>;
export type PricingConfig = typeof pricingConfig.$inferSelect;

// ==================== PAYMENT METHODS ====================

export const paymentMethods = pgTable("payment_methods", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  organizationId: integer("organization_id").references(() => organizations.id),
  provider: text("provider").default("stripe").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripePaymentMethodId: text("stripe_payment_method_id"),
  isDefault: boolean("is_default").default(false).notNull(),
  lastFour: varchar("last_four", { length: 4 }),
  expiryMonth: integer("expiry_month"),
  expiryYear: integer("expiry_year"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPaymentMethodSchema = createInsertSchema(paymentMethods).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPaymentMethod = z.infer<typeof insertPaymentMethodSchema>;
export type PaymentMethod = typeof paymentMethods.$inferSelect;

// ==================== PAYMENT HISTORIES ====================

export const paymentHistories = pgTable("payment_histories", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  organizationId: integer("organization_id").references(() => organizations.id),
  amount: integer("amount").notNull(),
  currency: varchar("currency", { length: 3 }).default("USD").notNull(),
  status: text("status").notNull(),
  description: text("description"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeInvoiceId: text("stripe_invoice_id"),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPaymentHistorySchema = createInsertSchema(paymentHistories).omit({
  id: true,
  createdAt: true,
});

export type InsertPaymentHistory = z.infer<typeof insertPaymentHistorySchema>;
export type PaymentHistory = typeof paymentHistories.$inferSelect;

// ==================== ORGANIZATION SEATS ====================

export const organizationSeats = pgTable("organization_seats", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  totalSeats: integer("total_seats").default(0).notNull(),
  usedSeats: integer("used_seats").default(0).notNull(),
  pricePerSeat: integer("price_per_seat").default(600).notNull(),
  discountPercent: integer("discount_percent").default(0).notNull(),
  billingCycleStart: timestamp("billing_cycle_start"),
  billingCycleEnd: timestamp("billing_cycle_end"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertOrganizationSeatSchema = createInsertSchema(organizationSeats).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOrganizationSeat = z.infer<typeof insertOrganizationSeatSchema>;
export type OrganizationSeat = typeof organizationSeats.$inferSelect;

// ==================== ACTIVATION TOKENS ====================

export const activationTokens = pgTable("activation_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ActivationToken = typeof activationTokens.$inferSelect;

// ==================== INVITE TOKENS ====================

export const inviteTokens = pgTable("invite_tokens", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  plan: userPlanEnum("plan").default("basic").notNull(),
  isAdmin: boolean("is_admin").default(false).notNull(),
  organizationId: integer("organization_id").references(() => organizations.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: integer("created_by").references(() => users.id),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type InviteToken = typeof inviteTokens.$inferSelect;

// ==================== SYSTEM CONFIG ====================

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

// ==================== FUND RETURN REQUESTS ====================

export const fundReturnRequests = pgTable("fund_return_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  amount: integer("amount").notNull(),
  reason: text("reason"),
  status: text("status").default("pending").notNull(),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertFundReturnRequestSchema = createInsertSchema(fundReturnRequests).omit({
  id: true,
  createdAt: true,
  reviewedAt: true,
});

export type InsertFundReturnRequest = z.infer<typeof insertFundReturnRequestSchema>;
export type FundReturnRequest = typeof fundReturnRequests.$inferSelect;
