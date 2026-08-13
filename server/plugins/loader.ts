import { readFile } from "fs/promises";
import semver from "semver";
import type { Express } from "express";
import type { Pool } from "pg";
import { VOX_PLUGIN_API_VERSION, type VoxPlugin } from "@vox/plugin-sdk";
import { parseManifest, type PluginManifest } from "./manifest";
import { resolveActivationOrder } from "./resolve";
import { runPluginMigrations } from "./migrate";
import { ServiceRegistry } from "./registry";
import { HttpHost } from "./hosts/http";
import { WorkerHost } from "./hosts/worker";
import { HealthHost } from "./hosts/health";
import { buildContext } from "./context";
import { BUILTIN_PLUGINS } from "../../plugins/index";

export interface LoadedPlugins {
  shutdown(): Promise<void>;
}

export async function loadPlugins(
  app: Express,
  pool: Pool,
  builtins: Record<string, VoxPlugin> = BUILTIN_PLUGINS,
  pluginsDir = "./plugins",
): Promise<LoadedPlugins> {
  const ids = (process.env.VOX_PLUGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { shutdown: async () => {} };

  // 1. discover + validate
  const manifests: PluginManifest[] = [];
  for (const id of ids) {
    if (!builtins[id]) throw new Error(`unknown plugin in VOX_PLUGINS: ${id}`);
    const raw = JSON.parse(await readFile(`${pluginsDir}/${id}/vox.plugin.json`, "utf-8"));
    const manifest = parseManifest(raw);
    if (manifest.id !== id) throw new Error(`plugin ${id}: manifest id mismatch (${manifest.id})`);
    if (!semver.satisfies(VOX_PLUGIN_API_VERSION, manifest.voxPluginApi)) {
      throw new Error(`plugin ${id} requires voxPluginApi ${manifest.voxPluginApi}; core provides ${VOX_PLUGIN_API_VERSION}`);
    }
    manifests.push(manifest);
  }

  // 2. resolve order
  const ordered = resolveActivationOrder(manifests);

  // 3. migrate
  await runPluginMigrations(pool, ordered, pluginsDir);

  // 4. activate in dependency order
  const registry = new ServiceRegistry();
  const httpHost = new HttpHost();
  const workerHost = new WorkerHost();
  const healthHost = new HealthHost();
  const activated: Array<{ id: string; plugin: VoxPlugin }> = [];

  for (const m of ordered) {
    const plugin = builtins[m.id];
    const ctx = buildContext(m, { pool, registry, httpHost, workerHost, healthHost });
    await plugin.activate(ctx);
    healthHost.setMeta(m.id, {
      version: m.version,
      provides: Object.keys(m.providesServices),
      requires: Object.keys(m.requiresServices),
    });
    activated.push({ id: m.id, plugin });
  }

  // 5. mount
  httpHost.mount(app);
  healthHost.routes(app);
  workerHost.startAll(pool);

  return {
    shutdown: async () => {
      await workerHost.stopAll();
      for (const { plugin } of [...activated].reverse()) {
        if (plugin.deactivate) await plugin.deactivate();
      }
    },
  };
}
