import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, timestamp, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const benchmarkResults = pgTable("benchmark_results", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull(),
  region: text("region").notNull(),
  responseLatency: integer("response_latency").notNull(),
  interruptLatency: integer("interrupt_latency").notNull(),
  networkResilience: integer("network_resilience").notNull(),
  naturalness: real("naturalness").notNull(),
  noiseReduction: integer("noise_reduction").notNull(),
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
