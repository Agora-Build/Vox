/**
 * force every platform.setup step into storage-mode using a
 * Core-minted storageState file. The daemon never sees login credentials —
 * this transform also strips any email/password params so leftover
 * placeholders can't reach temp YAML or logs.
 *
 * `mode` is set BOTH at step level and inside params: aeval-data examples put
 * it at step level, seed-data workflows put it under params — forcing both
 * covers either shape harmlessly.
 *
 * Two document shapes are accepted (parity with Core's parsePlatformSetup):
 * a bare list of steps, and a full scenario document `{ steps: [...] }`. The
 * transform dumps back the SAME shape it was given.
 */
import yaml from 'js-yaml';

export interface InjectResult {
  /** The rewritten YAML (unchanged input if nothing matched). */
  yaml: string;
  /** True iff at least one platform.setup step was forced to storage mode. */
  injected: boolean;
}

export function injectStorageSession(stepsYaml: string, storageFilePath: string): InjectResult {
  const doc = yaml.load(stepsYaml);

  // Locate the steps array in either shape.
  let steps: unknown[] | null = null;
  let docShape = false;
  if (Array.isArray(doc)) {
    steps = doc;
  } else if (doc && typeof doc === 'object' && Array.isArray((doc as { steps?: unknown }).steps)) {
    steps = (doc as { steps: unknown[] }).steps;
    docShape = true;
  }
  if (!steps) return { yaml: stepsYaml, injected: false };

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
  if (!changed) return { yaml: stepsYaml, injected: false };
  // Dump back the same shape we were handed.
  return { yaml: yaml.dump(docShape ? doc : steps), injected: true };
}
