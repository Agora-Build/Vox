/**
 * Phase C: force every platform.setup step into storage-mode using a
 * Core-minted storageState file. The daemon never sees login credentials —
 * this transform also strips any email/password params so leftover
 * placeholders can't reach temp YAML or logs.
 *
 * `mode` is set BOTH at step level and inside params: aeval-data examples put
 * it at step level, seed-data workflows put it under params — forcing both
 * covers either shape harmlessly.
 */
import yaml from 'js-yaml';

export function injectStorageSession(stepsYaml: string, storageFilePath: string): string {
  const steps = yaml.load(stepsYaml);
  if (!Array.isArray(steps)) return stepsYaml;
  let changed = false;
  for (const raw of steps) {
    const step = raw as { type?: string; mode?: string; params?: Record<string, unknown> };
    if (step?.type !== 'platform.setup') continue;
    changed = true;
    step.mode = 'storage';
    const params = (step.params ?? {}) as Record<string, unknown>;
    if ('mode' in params) params.mode = 'storage';
    params.storage_file = storageFilePath;
    delete params.email;
    delete params.password;
    step.params = params;
  }
  return changed ? yaml.dump(steps) : stepsYaml;
}
