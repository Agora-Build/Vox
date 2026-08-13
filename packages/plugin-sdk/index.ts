import type { RequestHandler } from "express";

/** Plugin API version Core implements. Plugins declare a compatible range in voxPluginApi. */
export const VOX_PLUGIN_API_VERSION = "1.0.0";

export type Handler = RequestHandler;

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ConfigReader {
  get(key: string): string | undefined;
  require(key: string): string; // throws if unset
}

export interface ServiceAccess {
  require<T>(name: string, range: string): T;      // unmet → throws
  optional<T>(name: string, range: string): T | null;
}

export interface PluginDb {
  readonly schema: string;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  withTransaction<T>(fn: (tx: PluginDb) => Promise<T>): Promise<T>;
}

export interface WorkerSpec {
  id: string;
  intervalMs: number;
  singleton?: boolean;
  run(): Promise<void>;
  onShutdown?(): Promise<void>;
}

export interface RouteRegistrar {
  get(path: string, ...handlers: Handler[]): void;
  post(path: string, ...handlers: Handler[]): void;
  patch(path: string, ...handlers: Handler[]): void;
  delete(path: string, ...handlers: Handler[]): void;
  requireAuth: Handler;
  requireAdmin: Handler;
}

export interface HealthReport { status: "ok" | "degraded" | "down"; detail?: string; }
export interface DrainReport { ready: boolean; blockers: string[]; }

export interface VoxPluginContext {
  readonly pluginId: string;
  readonly logger: Logger;
  readonly config: ConfigReader;
  readonly services: ServiceAccess;
  readonly db: PluginDb;
  http(register: (r: RouteRegistrar) => void): void;
  worker(spec: WorkerSpec): void;
  health(check: () => Promise<HealthReport>): void;
  drain?(check: () => Promise<DrainReport>): void;
  provideService<T>(name: string, version: string, impl: T): void;
}

export interface VoxPlugin {
  activate(ctx: VoxPluginContext): Promise<void>;
  deactivate?(): Promise<void>;
}
