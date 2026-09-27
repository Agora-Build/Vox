import type { Request, RequestHandler } from "express";

/** Plugin API version Core implements. Plugins declare a compatible range in voxPluginApi. */
export const VOX_PLUGIN_API_VERSION = "1.1.0";

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

// ---------------------------------------------------------------------------
// Services Core provides to plugins (plugin API >= 1.1.0)
// ---------------------------------------------------------------------------

/** A Core user, as much of it as a plugin may see. */
export interface IdentityUser {
  id: number;
  username: string;
  email: string;
  isAdmin: boolean;
  isEnabled: boolean;
  emailVerified: boolean;
}

/**
 * `vox.identity@1.0.0` — Core's users and sessions, for plugins that sign people
 * in (e.g. oauth). Core stays the only writer of users and sessions; a plugin
 * that needs a user goes through here rather than touching Core tables.
 */
export interface IdentityService {
  getUserById(id: number): Promise<IdentityUser | null>;
  getUserByEmail(email: string): Promise<IdentityUser | null>;
  /**
   * Creates a basic-plan user with no password and a verified email. The
   * username is derived from `preferredUsername` (or the email's local part)
   * and made unique by Core.
   */
  createUser(input: { email: string; preferredUsername?: string }): Promise<IdentityUser>;
  markEmailVerified(userId: number): Promise<void>;
  /**
   * Starts a Core session for `userId` on this request. The session is
   * regenerated first (new id, previous contents dropped), so an id that
   * existed before sign-in is never promoted to a signed-in one.
   */
  signIn(req: Request, userId: number): Promise<void>;
  /** Ends any Core session on this request. */
  signOut(req: Request): void;
}
