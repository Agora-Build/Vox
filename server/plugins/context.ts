import type { Pool } from "pg";
import type { VoxPluginContext, Logger, ConfigReader, RouteRegistrar } from "@vox/plugin-sdk";
import type { PluginManifest } from "./manifest";
import { ServiceRegistry } from "./registry";
import { HttpHost } from "./hosts/http";
import { WorkerHost } from "./hosts/worker";
import { HealthHost } from "./hosts/health";
import { createPluginDb, schemaForPlugin } from "./db";

export interface ContextDeps {
  pool: Pool;
  registry: ServiceRegistry;
  httpHost: HttpHost;
  workerHost: WorkerHost;
  healthHost: HealthHost;
}

export function buildContext(m: PluginManifest, deps: ContextDeps): VoxPluginContext {
  const db = createPluginDb(deps.pool, schemaForPlugin(m.id));

  const logger: Logger = {
    info: (msg, meta) => console.log(`[plugin:${m.id}] ${msg}`, meta ?? ""),
    warn: (msg, meta) => console.warn(`[plugin:${m.id}] ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`[plugin:${m.id}] ${msg}`, meta ?? ""),
  };

  const config: ConfigReader = {
    get: (key) => process.env[key],
    require: (key) => {
      const v = process.env[key];
      if (v === undefined) throw new Error(`plugin ${m.id} requires environment variable ${key}`);
      return v;
    },
  };

  // Memoized so that ctx.http() called multiple times reuses the SAME router.
  // HttpHost.createRegistrar(id) creates+stores a fresh Router keyed by plugin
  // id every time it's called; calling it twice for the same id would silently
  // drop the first router from mount() while its paths stay marked as taken.
  let registrar: RouteRegistrar | undefined;

  return {
    pluginId: m.id,
    logger,
    config,
    db,
    services: {
      require: (name, range) => deps.registry.require(name, range),
      optional: (name, range) => deps.registry.optional(name, range),
    },
    http: (register) => register(registrar ??= deps.httpHost.createRegistrar(m.id)),
    worker: (spec) => deps.workerHost.register(m.id, spec),
    health: (check) => deps.healthHost.register(m.id, check),
    provideService: (name, version, impl) => deps.registry.provide(name, version, impl),
  };
}
