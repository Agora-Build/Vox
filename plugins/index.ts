import type { VoxPlugin } from "@vox/plugin-sdk";

// Static map of in-tree plugins. Core resolves VOX_PLUGINS ids through this map
// (never a dynamic filesystem import), so the esbuild bundle includes plugin code.
// Task 11 adds `sample` here.
export const BUILTIN_PLUGINS: Record<string, VoxPlugin> = {};
