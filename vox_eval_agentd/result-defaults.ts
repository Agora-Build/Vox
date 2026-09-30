// What an eval result starts with for the metrics nothing measures yet (#217).
// These were placeholders — 85 / 3.5 / 90 — reported on every result as if
// measured, and the public boards ranked on them. Unmeasured is null (N/A).
export const UNMEASURED_DEFAULTS = {
  networkResilience: null,
  naturalness: null,
  noiseReduction: null,
} as const;
